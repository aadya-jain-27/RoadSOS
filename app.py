"""
RoadSoS — GPS-First Emergency Assistant Backend
================================================
Architecture: Coordinate-native, never city-aware.

Data flow for every request:
  1. Check in-memory LRU cache  (sub-millisecond, TTL 5 min)
  2. Check SQLite tile cache     (< 1 ms,  TTL 20 min)
  3. Query Overpass API          (live OSM, ~2–8 s, parallel)
  4. Expanding-radius fallback   (5 → 10 → 25 → 50 km if sparse results)
  5. SQLite emergency_contacts   (coordinate-ordered, no city snapping)

No step references a city name. Every query uses (lat, lon, radius_m).
"""

from flask import Flask, render_template, request, jsonify, send_from_directory, Response, stream_with_context
import requests
import json
import math
import os
import time
import sqlite3
import queue
import threading
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import OrderedDict

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "roadsos-2026-iitm")

# ── Live Incident SSE broadcast ────────────────────────────────
_incident_queues: list = []
_incident_lock   = threading.Lock()
_recent_incidents: list = []          # last 20 incidents in memory

# ─── Constants ────────────────────────────────────────────────
# Multiple Overpass mirrors — ALL fired in parallel, first response wins
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS_URL   = OVERPASS_MIRRORS[0]
NOMINATIM_URL  = "https://nominatim.openstreetmap.org/reverse"
HEADERS        = {"User-Agent": "RoadSoS/3.0 (hackathon@iitm.ac.in)"}
OVERPASS_TIMEOUT   = 10   # per-mirror HTTP timeout in seconds
OVERPASS_WAIT      = 10   # max seconds to wait for any mirror to respond
OVERALL_SVC_LIMIT  = 14   # fetch_all_services hard deadline in seconds

# Initial search radius — covers 99% of urban/suburban cases in one shot
INITIAL_RADIUS_KM = 10
# Fallback radii — only used if initial returns nothing (rural, highway)
EXPAND_RADII_KM   = [25, 50]
MIN_RESULTS       = 2    # accept sparse results rather than wait for expansion

# Tile size used for cache key bucketing (~1.1 km at equator)
TILE_DEGREES    = 0.01

# ─── In-memory LRU cache ──────────────────────────────────────
class LRUCache:
    """Thread-safe in-memory LRU with TTL."""
    def __init__(self, maxsize=512, ttl=300):
        self._cache: OrderedDict = OrderedDict()
        self._ttl   = ttl
        self._max   = maxsize
        self._lock  = threading.Lock()

    def _key(self, lat, lon, svc_key, radius_km):
        # Snap to tile grid so nearby calls share a cache entry
        tlat = round(lat / TILE_DEGREES) * TILE_DEGREES
        tlon = round(lon / TILE_DEGREES) * TILE_DEGREES
        return f"{tlat:.2f}|{tlon:.2f}|{svc_key}|{radius_km}"

    def get(self, lat, lon, svc_key, radius_km):
        k = self._key(lat, lon, svc_key, radius_km)
        with self._lock:
            if k not in self._cache:
                return None
            ts, data = self._cache[k]
            if time.time() - ts > self._ttl:
                del self._cache[k]
                return None
            self._cache.move_to_end(k)
            return data

    def put(self, lat, lon, svc_key, radius_km, data):
        k = self._key(lat, lon, svc_key, radius_km)
        with self._lock:
            self._cache[k] = (time.time(), data)
            self._cache.move_to_end(k)
            if len(self._cache) > self._max:
                self._cache.popitem(last=False)

_mem_cache = LRUCache(maxsize=512, ttl=300)   # 5-min TTL

# ─── SQLite Database ───────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), "database", "roadsos.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db_schema():
    """Ensure tile_cache table and indexes exist (idempotent)."""
    try:
        with get_db() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tile_cache (
                    cache_key  TEXT PRIMARY KEY,
                    svc_key    TEXT NOT NULL,
                    lat_tile   REAL NOT NULL,
                    lon_tile   REAL NOT NULL,
                    radius_km  INTEGER NOT NULL,
                    data_json  TEXT NOT NULL,
                    cached_at  INTEGER NOT NULL
                )
            """)
            # Geospatial-ish index on lat/lon tiles for nearby lookups
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_tile_cache_coords
                ON tile_cache(lat_tile, lon_tile, svc_key, radius_km)
            """)
            # Index for fast coordinate lookups on emergency_contacts
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_contacts_lat_lon
                ON emergency_contacts(lat, lon)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_contacts_category
                ON emergency_contacts(category, lat, lon)
            """)
    except Exception:
        pass   # table may already exist

init_db_schema()

TILE_CACHE_TTL = 1200   # 20 minutes

def tile_key(lat, lon, svc_key, radius_km):
    tlat = round(lat / TILE_DEGREES) * TILE_DEGREES
    tlon = round(lon / TILE_DEGREES) * TILE_DEGREES
    raw  = f"{tlat:.2f}|{tlon:.2f}|{svc_key}|{radius_km}"
    return hashlib.md5(raw.encode()).hexdigest()[:16], round(tlat, 2), round(tlon, 2)

def get_tile_cache(lat, lon, svc_key, radius_km):
    key, _, _ = tile_key(lat, lon, svc_key, radius_km)
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT data_json, cached_at FROM tile_cache WHERE cache_key=?", (key,)
            ).fetchone()
            if row and (time.time() - row["cached_at"]) < TILE_CACHE_TTL:
                return json.loads(row["data_json"])
    except Exception:
        pass
    return None

def set_tile_cache(lat, lon, svc_key, radius_km, data):
    key, tlat, tlon = tile_key(lat, lon, svc_key, radius_km)
    try:
        with get_db() as conn:
            conn.execute("""
                INSERT INTO tile_cache(cache_key,svc_key,lat_tile,lon_tile,radius_km,data_json,cached_at)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    data_json=excluded.data_json,
                    cached_at=excluded.cached_at
            """, (key, svc_key, tlat, tlon, radius_km, json.dumps(data), int(time.time())))
    except Exception:
        pass

def db_fallback_services(lat, lon, service_keys, radius_km=50):
    """
    Pure coordinate-based query against emergency_contacts.
    Uses haversine bounding box pre-filter then exact distance sort.
    No city names, no city snapping.
    """
    result = {}
    if not service_keys:
        return result

    # Bounding-box pre-filter: ±radius_km degrees (1 deg ≈ 111 km)
    lat_delta = radius_km / 111.0
    lon_delta = radius_km / (111.0 * math.cos(math.radians(lat)) + 1e-9)

    try:
        with get_db() as conn:
            for key in service_keys:
                rows = conn.execute("""
                    SELECT name, lat, lon, phone, category
                    FROM emergency_contacts
                    WHERE category = ?
                      AND lat BETWEEN ? AND ?
                      AND lon BETWEEN ? AND ?
                    LIMIT 50
                """, (
                    key,
                    lat - lat_delta, lat + lat_delta,
                    lon - lon_delta, lon + lon_delta
                )).fetchall()

                enriched = []
                svc = SERVICE_TYPES.get(key, {})
                for row in rows:
                    d = haversine(lat, lon, row["lat"], row["lon"])
                    if d <= radius_km:
                        enriched.append({
                            "name":         row["name"],
                            "lat":          row["lat"],
                            "lon":          row["lon"],
                            "phone":        row["phone"] or "",
                            "distance_km":  round(d, 2),
                            "type":         key,
                            "label":        svc.get("label", key),
                            "icon":         svc.get("icon", ""),
                            "opening_hours":"",
                            "website":      "",
                            "source":       "offline_db"
                        })
                enriched.sort(key=lambda x: x["distance_km"])
                result[key] = enriched[:5]
    except Exception:
        pass
    return result

# ─── Helplines DB ──────────────────────────────────────────────
def get_db_helplines(country_code):
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT service_type, number FROM emergency_helplines WHERE country_code = ?",
                (country_code,)
            ).fetchall()
            if not rows:
                rows = conn.execute(
                    "SELECT service_type, number FROM emergency_helplines WHERE country_code = 'DEFAULT'"
                ).fetchall()
            return {r["service_type"]: r["number"] for r in rows}
    except Exception:
        return EMERGENCY_NUMBERS.get(country_code, EMERGENCY_NUMBERS["DEFAULT"])

# ─── Static Data ───────────────────────────────────────────────
EMERGENCY_NUMBERS = {
    "IN":  {"police":"100","ambulance":"108","fire":"101","highway":"1033","disaster":"1070","women":"1091","child":"1098","railway":"139"},
    "PK":  {"police":"15","ambulance":"1122","fire":"16"},
    "BD":  {"police":"999","ambulance":"199","fire":"199"},
    "LK":  {"police":"119","ambulance":"110","fire":"111"},
    "NP":  {"police":"100","ambulance":"102","fire":"101"},
    "SG":  {"police":"999","ambulance":"995","fire":"995"},
    "MY":  {"police":"999","ambulance":"999","fire":"994"},
    "TH":  {"police":"191","ambulance":"1669","fire":"199"},
    "ID":  {"police":"110","ambulance":"118","fire":"113"},
    "PH":  {"police":"911","ambulance":"911","fire":"911"},
    "JP":  {"police":"110","ambulance":"119","fire":"119"},
    "CN":  {"police":"110","ambulance":"120","fire":"119"},
    "KR":  {"police":"112","ambulance":"119","fire":"119"},
    "AE":  {"police":"999","ambulance":"998","fire":"997","highway":"800 4673"},
    "SA":  {"police":"999","ambulance":"997","fire":"998"},
    "TR":  {"police":"155","ambulance":"112","fire":"110"},
    "UK":  {"police":"999","ambulance":"999","fire":"999","non_emergency":"101"},
    "DE":  {"police":"110","ambulance":"112","fire":"112"},
    "FR":  {"police":"17","ambulance":"15","fire":"18","eu":"112"},
    "IT":  {"police":"113","ambulance":"118","fire":"115"},
    "US":  {"police":"911","ambulance":"911","fire":"911","highway":"511"},
    "CA":  {"police":"911","ambulance":"911","fire":"911"},
    "BR":  {"police":"190","ambulance":"192","fire":"193"},
    "AU":  {"police":"000","ambulance":"000","fire":"000","highway":"13 17 82"},
    "NZ":  {"police":"111","ambulance":"111","fire":"111"},
    "ZA":  {"police":"10111","ambulance":"10177","fire":"10177"},
    "NG":  {"police":"112","ambulance":"199","fire":"112"},
    "KE":  {"police":"999","ambulance":"999","fire":"999"},
    "DEFAULT": {"police":"112","ambulance":"112","fire":"112"}
}

SERVICE_TYPES = {
    "hospital":       {"tags": ['["amenity"="hospital"]'],                                              "label": "Hospital / Trauma Centre", "icon": "H",  "priority": 1},
    "ambulance":      {"tags": ['["emergency"="ambulance_station"]'],                                   "label": "Ambulance Station",        "icon": "AM", "priority": 1},
    "police":         {"tags": ['["amenity"="police"]'],                                                "label": "Police Station",           "icon": "P",  "priority": 1},
    "fire_station":   {"tags": ['["amenity"="fire_station"]'],                                          "label": "Fire Station",             "icon": "F",  "priority": 2},
    "towing":         {"tags": ['["service"="vehicle_recovery"]','["amenity"="vehicle_inspection"]'],   "label": "Towing Service",           "icon": "T",  "priority": 2},
    "puncture":       {"tags": ['["shop"="tyres"]','["shop"="bicycle"]'],                               "label": "Tyre / Puncture Shop",     "icon": "TY", "priority": 2},
    "vehicle_repair": {"tags": ['["shop"="car_repair"]','["shop"="motorcycle_repair"]'],                "label": "Vehicle Repair",           "icon": "VR", "priority": 2},
    "showroom":       {"tags": ['["shop"="car"]','["amenity"="car_rental"]'],                           "label": "Car Showroom / Rental",    "icon": "CR", "priority": 3},
    "pharmacy":       {"tags": ['["amenity"="pharmacy"]'],                                              "label": "Pharmacy",                 "icon": "PH", "priority": 2},
    "clinic":         {"tags": ['["amenity"="clinic"]','["amenity"="doctors"]'],                        "label": "Clinic / Doctor",          "icon": "CL", "priority": 2},
    "blood_bank":     {"tags": ['["amenity"="blood_donation_centre"]','["healthcare"="blood_bank"]','["amenity"="blood_bank"]'], "label": "Blood Bank", "icon": "BB", "priority": 1},
}

FIRST_AID = {
    "accident": {
        "title": "Road Accident — Immediate Steps",
        "steps": [
            "Turn on hazard lights. Keep people away from traffic. Set warning triangles if available.",
            "Call 108 (ambulance) and 100 (police) immediately. Stay on line with dispatcher.",
            "Do NOT move the injured — risk of spinal injury. Keep them still and calm.",
            "Check for breathing. Tilt head back, lift chin. Look, listen, feel for 10 seconds.",
            "If trained: start CPR. 30 chest compressions then 2 rescue breaths. Continue until help arrives.",
            "Control severe bleeding: press firmly with clean cloth. Do not remove the cloth.",
            "Do not give food, water, or medication to injured persons.",
            "Note exact location (nearest milestone, GPS coordinates) to guide ambulance.",
            "If vehicle is smoking or leaking fuel, move everyone at least 50m away immediately."
        ]
    },
    "fire": {
        "title": "Vehicle Fire — Immediate Steps",
        "steps": [
            "Stop the vehicle, switch off engine, activate hazard lights.",
            "Evacuate everyone immediately — do not collect belongings.",
            "Move at least 50 metres away from the vehicle upwind.",
            "Call 101 (fire) and 108 (ambulance) immediately.",
            "If fire is small and you have a dry-powder extinguisher, aim at the base.",
            "Never open bonnet if fire is inside engine bay — oxygen feeds the fire.",
            "Keep bystanders back — fuel tank can explode."
        ]
    },
    "unconscious": {
        "title": "Unconscious Person — Immediate Steps",
        "steps": [
            "Check response: tap shoulders firmly, shout 'Are you okay?'",
            "If unresponsive, call 108 immediately.",
            "Open airway: tilt head back, lift chin gently.",
            "Check breathing for 10 seconds. Look for chest rise.",
            "If breathing: place in recovery position (on their side) to prevent choking.",
            "If not breathing: start CPR — 30 compressions (hard and fast), 2 rescue breaths.",
            "Do not leave the person alone. Send someone else to guide the ambulance."
        ]
    },
    "bleeding": {
        "title": "Severe Bleeding — Immediate Steps",
        "steps": [
            "Apply direct pressure using a clean cloth, shirt, or bandage — press hard.",
            "Do not remove the cloth — add more on top if it soaks through.",
            "Raise the injured limb above heart level if possible.",
            "For limb bleeding: improvise a tourniquet 5–8 cm above the wound if bleeding is life-threatening.",
            "Note the time you applied the tourniquet — tell paramedics.",
            "Keep the person warm and lying down to prevent shock.",
            "Call 108 immediately."
        ]
    },
    "cpr": {
        "title": "CPR — Cardiopulmonary Resuscitation",
        "steps": [
            "Check the scene is safe, then check the person: tap shoulders, shout 'Are you OK?'",
            "If unresponsive and not breathing normally, call 108 immediately or ask someone else to call.",
            "Lay the person flat on their back on a firm surface.",
            "Place heel of one hand on centre of chest (lower half of breastbone). Place other hand on top, fingers interlocked.",
            "Compress chest hard and fast — at least 5 cm deep, 100–120 compressions per minute (same beat as 'Stayin' Alive').",
            "After 30 compressions: tilt head back, lift chin. Pinch nose, seal mouth, give 2 breaths (1 second each, watch chest rise).",
            "Continue 30 compressions : 2 breaths until ambulance arrives, AED is available, or person recovers.",
            "If an AED arrives: switch it on and follow voice instructions immediately."
        ]
    },
    "fracture": {
        "title": "Suspected Fracture — Immediate Steps",
        "steps": [
            "Do NOT try to straighten or move the broken bone — keep it still.",
            "Immobilise the injury: support with your hands or improvise a splint (rolled newspaper, sticks) above and below the break.",
            "For open fracture (bone visible): cover loosely with clean cloth — do not press on bone.",
            "Apply a cold pack or cloth-wrapped ice to reduce swelling. Never apply ice directly to skin.",
            "Elevate the injured limb gently if possible and if it doesn't cause pain.",
            "Watch for signs of shock: pale/cold skin, dizziness, rapid breathing — lay the person down, keep warm.",
            "Call 108 if the fracture is near the spine, pelvis, femur, or if there is significant blood loss."
        ]
    },
    "burn": {
        "title": "Burns — Immediate Treatment",
        "steps": [
            "Remove the person from the heat source. Stop, drop, and roll if clothing is on fire.",
            "Cool the burn under cool (not cold or icy) running water for at least 20 minutes.",
            "Do NOT use butter, toothpaste, ice, or any cream — these worsen burns.",
            "Remove jewellery, watches, and clothing near the burn before swelling begins (unless stuck to skin).",
            "Cover loosely with cling film or a clean non-fluffy cloth. Do not wrap tightly.",
            "For chemical burns: brush off dry chemical first, then irrigate with large amounts of water for 20+ minutes.",
            "Call 108 for burns larger than palm size, burns on face/hands/genitals/joints, or any chemical/electrical burn."
        ]
    },
    "choking": {
        "title": "Choking — Immediate Steps",
        "steps": [
            "Ask 'Are you choking?' — if they can cough or speak, encourage forceful coughing.",
            "If they cannot cough, speak, or breathe: call 108 immediately (or ask someone to).",
            "Lean them forward. Give up to 5 firm back blows between shoulder blades with heel of hand.",
            "If back blows fail: stand behind them, make a fist just above navel, grasp with other hand, give up to 5 sharp inward-upward thrusts (Heimlich manoeuvre).",
            "Alternate 5 back blows and 5 abdominal thrusts until object is expelled or person becomes unconscious.",
            "If unconscious: lower carefully to ground and start CPR — chest compressions may dislodge the object.",
            "For infants (under 1 year): use 5 back blows then 5 chest thrusts (NOT abdominal thrusts)."
        ]
    }
}

# ─── Core Geospatial ──────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return round(R * 2 * math.asin(math.sqrt(min(a, 1.0))), 2)

def get_location_info(lat, lon):
    """Reverse geocode lat/lon → (display_name, short_name, country_code)."""
    try:
        r = requests.get(
            NOMINATIM_URL,
            params={"lat": lat, "lon": lon, "format": "json"},
            headers=HEADERS, timeout=4
        )
        d = r.json()
        addr = d.get("address", {})
        cc   = addr.get("country_code", "").upper()
        display = d.get("display_name", f"{lat:.4f}, {lon:.4f}")
        short = ", ".join(filter(None, [
            addr.get("road") or addr.get("suburb"),
            addr.get("city") or addr.get("town") or addr.get("village") or addr.get("state_district"),
            addr.get("state"),
            addr.get("country")
        ]))
        return display, short or display, cc
    except Exception:
        return f"{lat:.4f}, {lon:.4f}", f"{lat:.4f}, {lon:.4f}", "DEFAULT"

# ─── Overpass Query Engine ─────────────────────────────────────
_mirror_failures: dict = {}   # mirror_url -> failed_at timestamp
_mirror_lock = threading.Lock()

def _mark_mirror_failed(url: str):
    with _mirror_lock:
        _mirror_failures[url] = time.time()

def _query_mirror(mirror: str, query: str) -> list:
    """POST to one Overpass mirror; return elements list or raise."""
    r = requests.post(
        mirror,
        data={"data": query},
        headers=HEADERS,
        timeout=OVERPASS_TIMEOUT
    )
    r.raise_for_status()
    data = r.json()
    return data.get("elements", [])

def _all_mirrors_down() -> bool:
    """True if every mirror is still within its cooldown window."""
    now = time.time()
    with _mirror_lock:
        return all(now - _mirror_failures.get(m, 0) < 90 for m in OVERPASS_MIRRORS)

def _overpass_query_single_tag(lat, lon, tag, radius_m, limit=8) -> list:
    """
    Fire one Overpass tag query to ALL available mirrors IN PARALLEL.
    First successful response wins. Returns [] if all fail or all are
    in their cooldown window (don't even try — go straight to DB).
    """
    # Fast path: if every mirror is in cooldown, skip entirely
    if _all_mirrors_down():
        return []

    query = (
        f"[out:json][timeout:{OVERPASS_TIMEOUT}];"
        f"(node{tag}(around:{radius_m},{lat},{lon});"
        f"way{tag}(around:{radius_m},{lat},{lon}););"
        f"out center {limit + 5};"
    )

    result_holder = [None]
    result_event  = threading.Event()
    result_lock   = threading.Lock()

    def attempt(mirror):
        now = time.time()
        with _mirror_lock:
            if now - _mirror_failures.get(mirror, 0) < 90:
                return   # this mirror is in hard-failure cooldown
        try:
            elements = _query_mirror(mirror, query)
            with result_lock:
                if result_holder[0] is None:
                    result_holder[0] = elements
                    result_event.set()
        except requests.exceptions.Timeout:
            # Timeout = slow, not dead. Don't penalise — another mirror may be faster.
            pass
        except Exception:
            # Connection error, SSL error, HTTP 5xx = actually broken.
            _mark_mirror_failed(mirror)

    threads = [threading.Thread(target=attempt, args=(m,), daemon=True)
               for m in OVERPASS_MIRRORS]
    for t in threads:
        t.start()

    result_event.wait(timeout=OVERPASS_WAIT)
    return result_holder[0] if result_holder[0] is not None else []

def fetch_service_live(lat, lon, svc_key, radius_m, limit=5) -> list:
    """
    Query Overpass for one service type at given radius.
    Returns deduplicated list sorted by distance.
    """
    svc = SERVICE_TYPES.get(svc_key, {})
    all_elements = []

    for tag in svc.get("tags", []):
        all_elements.extend(_overpass_query_single_tag(lat, lon, tag, radius_m, limit))

    # Deduplicate + enrich
    seen: set = set()
    results: list = []
    for el in all_elements:
        elat = el.get("lat") or el.get("center", {}).get("lat")
        elon = el.get("lon") or el.get("center", {}).get("lon")
        if not elat or not elon:
            continue
        coord_key = (round(elat, 4), round(elon, 4))
        if coord_key in seen:
            continue
        seen.add(coord_key)

        tags  = el.get("tags", {})
        name  = (tags.get("name:en") or tags.get("name") or svc.get("label", svc_key)).strip()
        phone = (
            tags.get("phone") or tags.get("contact:phone") or
            tags.get("contact:mobile") or tags.get("mobile") or ""
        ).replace(";", " / ").strip()

        results.append({
            "name":          name,
            "lat":           elat,
            "lon":           elon,
            "phone":         phone,
            "website":       tags.get("website") or tags.get("contact:website") or "",
            "opening_hours": tags.get("opening_hours") or "",
            "distance_km":   haversine(lat, lon, elat, elon),
            "type":          svc_key,
            "label":         svc.get("label", svc_key),
            "icon":          svc.get("icon", ""),
            "source":        "live_osm"
        })

    results.sort(key=lambda x: x["distance_km"])
    return results[:limit]

# ─── Expanding Radius Strategy ─────────────────────────────────
def fetch_with_expanding_radius(lat, lon, svc_key, min_results=MIN_RESULTS) -> list:
    """
    Fetch strategy — optimised for sub-10s response:

    1. Memory LRU cache — instant, only stores NON-EMPTY live_osm results
    2. SQLite tile cache — fast, only stores NON-EMPTY live_osm results
    3. Single Overpass query at INITIAL_RADIUS_KM (10km), parallel mirrors
    4. If empty → expand to 25km, 50km (rural/highway edge case only)
    5. Coordinate-sorted offline DB — last resort, never city-snapping

    Rule: empty results and offline_db results are NEVER cached.
    Only real live OSM data gets into cache.
    """
    # 1. Memory cache — only non-empty live results are ever stored here
    cached = _mem_cache.get(lat, lon, svc_key, INITIAL_RADIUS_KM)
    if cached:   # truthy check — ignores None AND []
        return cached

    # 2. SQLite tile cache — same guarantee
    tile_cached = get_tile_cache(lat, lon, svc_key, INITIAL_RADIUS_KM)
    if tile_cached:   # truthy — ignores None AND []
        _mem_cache.put(lat, lon, svc_key, INITIAL_RADIUS_KM, tile_cached)
        return tile_cached

    # 3. Live Overpass query at 10km
    if not _all_mirrors_down():
        data = fetch_service_live(lat, lon, svc_key, INITIAL_RADIUS_KM * 1000, limit=8)
        if data:
            # Only cache non-empty live results
            set_tile_cache(lat, lon, svc_key, INITIAL_RADIUS_KM, data)
            _mem_cache.put(lat, lon, svc_key, INITIAL_RADIUS_KM, data)
            return data

    # 4. Expand to 25km then 50km — only when 10km is genuinely empty
    for radius_km in EXPAND_RADII_KM:
        tile_cached = get_tile_cache(lat, lon, svc_key, radius_km)
        if tile_cached:
            _mem_cache.put(lat, lon, svc_key, radius_km, tile_cached)
            return tile_cached

        if _all_mirrors_down():
            break

        data = fetch_service_live(lat, lon, svc_key, radius_km * 1000, limit=8)
        if data:
            set_tile_cache(lat, lon, svc_key, radius_km, data)
            _mem_cache.put(lat, lon, svc_key, radius_km, data)
            return data

    # 5. Offline DB — coordinate-sorted, 50km radius, no city snapping
    db = db_fallback_services(lat, lon, [svc_key], radius_km=50)
    return db.get(svc_key, [])

def fetch_all_services(lat, lon, service_keys, preferred_radius_km=10) -> dict:
    """
    Parallel fetch for multiple service types.
    Hard deadline: OVERALL_SVC_LIMIT seconds total.
    Services that don't finish in time fall back to DB instantly.
    """
    results: dict = {}
    deadline = time.time() + OVERALL_SVC_LIMIT

    with ThreadPoolExecutor(max_workers=min(len(service_keys), 8)) as ex:
        futures = {
            ex.submit(fetch_with_expanding_radius, lat, lon, k): k
            for k in service_keys
        }
        remaining = max(1.0, deadline - time.time())
        try:
            for f in as_completed(futures, timeout=remaining):
                k = futures[f]
                try:
                    results[k] = f.result()
                except Exception:
                    results[k] = []
        except TimeoutError:
            # Collect whatever finished; leave the rest empty for DB fallback
            for f, k in futures.items():
                if k not in results:
                    results[k] = [] if not f.done() else (f.result() if not f.exception() else [])

    # Any service that got nothing → DB fallback
    empty_keys = [k for k in service_keys if not results.get(k)]
    if empty_keys:
        db = db_fallback_services(lat, lon, empty_keys, radius_km=50)
        for k, v in db.items():
            if v:
                results[k] = v

    return results

# ─── Intent Parser ─────────────────────────────────────────────
def parse_intent(message):
    m = message.lower()
    services, intent, first_aid_key = [], "general", None

    if any(w in m for w in ["unconscious", "not breathing", "no pulse", "cardiac", "heart attack", "stroke"]):
        services = ["hospital", "ambulance", "police"]
        intent, first_aid_key = "critical", "unconscious"
    elif any(w in m for w in ["accident", "crash", "collision", "hit", "injured", "hurt", "bleeding", "pain"]):
        services = ["hospital", "ambulance", "police", "pharmacy"]
        intent, first_aid_key = "accident", "accident"
    elif any(w in m for w in ["fire", "burning", "smoke", "explosion", "fuel leak"]):
        services = ["fire_station", "hospital", "ambulance", "police"]
        intent, first_aid_key = "fire", "fire"
    elif any(w in m for w in ["bleed", "blood", "cut", "wound", "injury"]):
        services = ["hospital", "ambulance", "pharmacy"]
        intent, first_aid_key = "accident", "bleeding"
    elif any(w in m for w in ["breakdown", "tyre", "tire", "puncture", "flat", "engine", "stuck", "stranded"]):
        services = ["vehicle_repair", "towing", "puncture", "showroom"]
        intent = "breakdown"
    elif any(w in m for w in ["mechanic", "repair", "workshop", "service centre"]):
        services = ["vehicle_repair", "towing", "puncture"]
        intent = "breakdown"
    elif any(w in m for w in ["tow", "towing", "crane", "recovery"]):
        services = ["towing", "vehicle_repair"]
        intent = "breakdown"
    elif any(w in m for w in ["police", "fir", "crime", "theft", "stolen", "report"]):
        services = ["police"]
        intent = "police"
    elif any(w in m for w in ["medicine", "pharmacy", "drug", "chemist", "first aid kit"]):
        services = ["pharmacy", "clinic"]
        intent = "medical"
    elif any(w in m for w in ["sos", "emergency", "help", "need help", "mayday"]):
        services = ["hospital", "ambulance", "police", "vehicle_repair"]
        intent, first_aid_key = "sos", "accident"
    else:
        services = ["hospital", "ambulance", "police", "vehicle_repair", "pharmacy"]
        intent = "general"

    return list(dict.fromkeys(services)), intent, first_aid_key

def build_full_response(lat, lon, services_requested) -> dict:
    display, short_addr, cc = get_location_info(lat, lon)
    numbers      = get_db_helplines(cc) or EMERGENCY_NUMBERS.get(cc, EMERGENCY_NUMBERS["DEFAULT"])
    service_data = fetch_all_services(lat, lon, services_requested)
    total        = sum(len(v) for v in service_data.values())
    return {
        "location_full":    display,
        "location_short":   short_addr,
        "country_code":     cc,
        "emergency_numbers": numbers,
        "services":         service_data,
        "total_contacts":   total,
        "lat":              lat,
        "lon":              lon,
        "timestamp":        time.strftime("%d %b %Y, %H:%M")
    }

# ─── Flask Routes ──────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/sw.js")
def sw():
    return send_from_directory("static", "sw.js", mimetype="application/javascript")

@app.route("/manifest.json")
def manifest():
    return send_from_directory("static", "manifest.json", mimetype="application/json")

# ── REST: /api/nearby/<type> ───────────────────────────────────
@app.route("/api/nearby/<svc_type>", methods=["GET", "POST"])
def nearby(svc_type):
    """
    GPS-first search for a single service type.

    GET  /api/nearby/hospitals?lat=28.67&lon=77.45&radius=10
    POST /api/nearby/hospitals  body: {"lat":28.67,"lon":77.45,"radius":10}

    Response:
    {
      "type": "hospitals",
      "results": [
        {"name":..., "address":..., "distance_km":..., "phone":...,
         "lat":..., "lon":..., "source":"live_osm"|"offline_db"}
      ],
      "count": 3,
      "searched_radius_km": 10,
      "lat": 28.67,
      "lon": 77.45,
      "location_short": "Ghaziabad, Uttar Pradesh"
    }
    """
    # Map URL aliases to internal keys
    alias = {
        "hospitals":  "hospital",
        "police":     "police",
        "ambulance":  "ambulance",
        "mechanics":  "vehicle_repair",
        "pharmacies": "pharmacy",
        "towing":     "towing",
        "fire":       "fire_station",
        "clinics":    "clinic",
        "puncture":   "puncture",
    }
    svc_key = alias.get(svc_type, svc_type)
    if svc_key not in SERVICE_TYPES:
        return jsonify({"error": f"Unknown service type: {svc_type}. Valid: {list(alias.keys())}"}), 400

    if request.method == "POST":
        data = request.json or {}
    else:
        data = request.args

    try:
        lat    = float(data.get("lat"))
        lon    = float(data.get("lon"))
        radius = int(data.get("radius", 10))
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lon are required (numeric)"}), 400

    radius = max(1, min(radius, 100))    # clamp 1–100 km
    _, short_addr, cc = get_location_info(lat, lon)

    # Expand radius until results found
    results = fetch_with_expanding_radius(lat, lon, svc_key)
    actual_radius = _infer_actual_radius(results)

    return jsonify({
        "type":               svc_type,
        "results":            results,
        "count":              len(results),
        "searched_radius_km": actual_radius,
        "lat":                lat,
        "lon":                lon,
        "location_short":     short_addr,
        "country_code":       cc,
        "timestamp":          time.strftime("%d %b %Y, %H:%M")
    })

def _infer_actual_radius(results) -> float:
    """Return the distance of the furthest result, or 0 if empty."""
    if not results:
        return 0
    return max(r.get("distance_km", 0) for r in results)

# ── REST: legacy endpoints kept for JS compatibility ───────────
@app.route("/api/quick", methods=["POST"])
def quick():
    data        = request.json or {}
    lat         = data.get("lat")
    lon         = data.get("lon")
    service_type = data.get("type", "hospital")
    if not lat or not lon:
        return jsonify({"error": "Location required"}), 400

    _, short_addr, cc = get_location_info(lat, lon)
    numbers           = get_db_helplines(cc) or EMERGENCY_NUMBERS.get(cc, EMERGENCY_NUMBERS["DEFAULT"])
    service_data      = fetch_all_services(lat, lon, [service_type])
    return jsonify({
        "type":             "services",
        "location_short":   short_addr,
        "country_code":     cc,
        "emergency_numbers": numbers,
        "services":         service_data,
        "total_contacts":   sum(len(v) for v in service_data.values()),
        "lat": lat, "lon": lon,
        "timestamp":        time.strftime("%d %b %Y, %H:%M")
    })

@app.route("/api/sos", methods=["POST"])
def sos():
    data = request.json or {}
    lat  = data.get("lat")
    lon  = data.get("lon")
    if not lat or not lon:
        return jsonify({"error": "Location required"}), 400

    priority  = ["hospital", "ambulance", "police"]
    secondary = ["fire_station", "pharmacy", "vehicle_repair", "towing", "puncture"]
    _, short_addr, cc = get_location_info(lat, lon)
    numbers  = get_db_helplines(cc) or EMERGENCY_NUMBERS.get(cc, EMERGENCY_NUMBERS["DEFAULT"])
    all_data = fetch_all_services(lat, lon, priority + secondary)
    return jsonify({
        "type":             "sos",
        "location_short":   short_addr,
        "country_code":     cc,
        "emergency_numbers": numbers,
        "services":         all_data,
        "total_contacts":   sum(len(v) for v in all_data.values()),
        "first_aid":        FIRST_AID["accident"],
        "lat": lat, "lon": lon,
        "timestamp":        time.strftime("%d %b %Y, %H:%M")
    })

@app.route("/api/chat", methods=["POST"])
def chat():
    data    = request.json or {}
    message = (data.get("message") or "").strip()
    lat     = data.get("lat")
    lon     = data.get("lon")
    m       = message.lower()

    if m in ["hi","hello","hey","start","hii","helo"] or (len(m.split()) <= 2 and any(w in m for w in ["hi","hello","hey"])):
        return jsonify({
            "type": "greeting",
            "text": "Hello! I'm RoadSoS — your GPS-based emergency assistant. I find the nearest hospitals, ambulances, police, and mechanics from wherever you are. Share your location and describe your situation."
        })

    if any(w in m for w in ["first aid","what do i do","how to help","cpr","steps","guide"]):
        key = ("unconscious" if "unconscious" in m else
               "fire" if "fire" in m else
               "bleed" if "bleed" in m else "accident")
        fa = FIRST_AID.get(key, FIRST_AID["accident"])
        return jsonify({"type": "first_aid", "title": fa["title"], "steps": fa["steps"]})

    if lat and lon:
        services, intent, fa_key = parse_intent(message)
        resp = build_full_response(lat, lon, services)
        resp["type"]      = "services"
        resp["intent"]    = intent
        resp["first_aid"] = FIRST_AID.get(fa_key, {}) if fa_key else {}
        return jsonify(resp)

    return jsonify({
        "type": "request_location",
        "text": "To find nearby emergency services, I need your location. Please tap the location button."
    })

@app.route("/api/triage", methods=["POST"])
def triage():
    data     = request.json or {}
    lat      = data.get("lat")
    lon      = data.get("lon")
    if not lat or not lon:
        return jsonify({"error": "Location required"}), 400
    services = data.get("services", ["hospital", "ambulance", "police"])
    fa_key   = data.get("fa_key", "accident")
    _, short_addr, cc = get_location_info(lat, lon)
    numbers      = get_db_helplines(cc) or EMERGENCY_NUMBERS.get(cc, EMERGENCY_NUMBERS["DEFAULT"])
    service_data = fetch_all_services(lat, lon, services)
    return jsonify({
        "type":             "services",
        "location_short":   short_addr,
        "country_code":     cc,
        "emergency_numbers": numbers,
        "services":         service_data,
        "total_contacts":   sum(len(v) for v in service_data.values()),
        "first_aid":        FIRST_AID.get(fa_key, FIRST_AID["accident"]),
        "lat": lat, "lon": lon,
        "timestamp":        time.strftime("%d %b %Y, %H:%M")
    })

@app.route("/api/first_aid/<key>")
def first_aid(key):
    fa = FIRST_AID.get(key)
    if not fa:
        return jsonify({"error": "Not found"}), 404
    return jsonify(fa)

@app.route("/api/emergency_numbers/<cc>")
def emergency_numbers(cc):
    return jsonify(EMERGENCY_NUMBERS.get(cc.upper(), EMERGENCY_NUMBERS["DEFAULT"]))

# ── Cache status endpoint (debug / demo) ──────────────────────
@app.route("/api/cache_status")
def cache_status():
    try:
        with get_db() as conn:
            tile_count = conn.execute("SELECT COUNT(*) FROM tile_cache").fetchone()[0]
            tile_fresh = conn.execute(
                "SELECT COUNT(*) FROM tile_cache WHERE cached_at > ?",
                (int(time.time()) - TILE_CACHE_TTL,)
            ).fetchone()[0]
    except Exception:
        tile_count = tile_fresh = 0
    now = time.time()
    mirror_status = {}
    for url in OVERPASS_MIRRORS:
        failed_at = _mirror_failures.get(url, 0)
        cooldown_left = max(0, 90 - (now - failed_at))
        mirror_status[url] = "ok" if cooldown_left == 0 else f"cooldown {cooldown_left:.0f}s"

    return jsonify({
        "mem_cache_entries": len(_mem_cache._cache),
        "tile_cache_total":  tile_count,
        "tile_cache_fresh":  tile_fresh,
        "tile_ttl_secs":     TILE_CACHE_TTL,
        "mem_ttl_secs":      _mem_cache._ttl,
        "overpass_mirrors":  mirror_status,
        "search_radii_km":   SEARCH_RADII_KM
    })

# ── Live Incident SSE ─────────────────────────────────────────
@app.route("/api/incident_stream")
def incident_stream():
    def generate():
        q = queue.Queue(maxsize=50)
        with _incident_lock:
            _incident_queues.append(q)
        try:
            for inc in _recent_incidents[-5:]:
                yield f"data: {json.dumps(inc)}\n\n"
            while True:
                try:
                    data = q.get(timeout=25)
                    yield f"data: {json.dumps(data)}\n\n"
                except queue.Empty:
                    yield 'data: {"type":"ping"}\n\n'
        finally:
            with _incident_lock:
                if q in _incident_queues:
                    _incident_queues.remove(q)
    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )

@app.route("/api/report_incident", methods=["POST"])
def report_incident():
    data = request.json or {}
    lat  = data.get("lat")
    lon  = data.get("lon")
    incident = {
        "type":     "incident",
        "kind":     data.get("kind", "accident"),
        "severity": data.get("severity", "unknown"),
        "lat":      lat,
        "lon":      lon,
        "location": data.get("location", "Unknown location"),
        "vehicles": data.get("vehicles", 1),
        "injuries": data.get("injuries", "Unknown"),
        "time":     time.strftime("%H:%M"),
        "id":       str(int(time.time() * 1000))
    }
    _recent_incidents.append(incident)
    if len(_recent_incidents) > 20:
        _recent_incidents.pop(0)
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO incidents (lat,lon,kind,severity,location,vehicles,injuries) VALUES (?,?,?,?,?,?,?)",
                (lat, lon, incident["kind"], incident["severity"],
                 incident["location"], incident["vehicles"], incident["injuries"])
            )
    except Exception:
        pass
    with _incident_lock:
        for q in _incident_queues[:]:
            try:
                q.put_nowait(incident)
            except queue.Full:
                pass
    return jsonify({"ok": True, "incident": incident})

@app.route("/api/register_responder", methods=["POST"])
def register_responder():
    data  = request.json or {}
    name  = (data.get("name") or "").strip()
    skill = (data.get("skill") or "").strip()
    phone = (data.get("phone") or "").strip()
    lat   = data.get("lat")
    lon   = data.get("lon")
    if not name or not skill or not lat or not lon:
        return jsonify({"error": "name, skill, and location required"}), 400
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO civilian_responders (name,skill,phone,lat,lon) VALUES (?,?,?,?,?)",
                (name, skill, phone, lat, lon)
            )
        return jsonify({"ok": True, "message": f"Registered {name} as {skill}. You will be alerted for emergencies within 2 km."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/nearby_responders", methods=["POST"])
def nearby_responders():
    data = request.json or {}
    lat  = data.get("lat")
    lon  = data.get("lon")
    if not lat or not lon:
        return jsonify({"responders": []})
    lat_delta = 3 / 111.0
    lon_delta = 3 / (111.0 * math.cos(math.radians(lat)) + 1e-9)
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT name, skill, phone, lat, lon
                FROM civilian_responders
                WHERE available = 1
                  AND lat BETWEEN ? AND ?
                  AND lon BETWEEN ? AND ?
                LIMIT 20
            """, (lat - lat_delta, lat + lat_delta, lon - lon_delta, lon + lon_delta)).fetchall()
        results = []
        for r in rows:
            d = haversine(lat, lon, r["lat"], r["lon"])
            if d <= 3:
                results.append({
                    "name":        r["name"],
                    "skill":       r["skill"],
                    "phone":       r["phone"] or "",
                    "distance_km": d
                })
        results.sort(key=lambda x: x["distance_km"])
        return jsonify({"responders": results[:5]})
    except Exception:
        return jsonify({"responders": []})

# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    app.run(debug=True, host="0.0.0.0", port=args.port)
