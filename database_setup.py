"""
RoadSoS Database Setup
Creates and populates roadsos.db — the structured database for emergency services.
Run once: python database_setup.py
"""
import sqlite3, json, os, math

DB_PATH = os.path.join(os.path.dirname(__file__), "database", "roadsos.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()

# ── Schema ────────────────────────────────────────────────────────────────────

c.executescript("""
DROP TABLE IF EXISTS emergency_contacts;
DROP TABLE IF EXISTS emergency_helplines;
DROP TABLE IF EXISTS osm_cache;

CREATE TABLE IF NOT EXISTS emergency_contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    city        TEXT NOT NULL,
    country     TEXT NOT NULL DEFAULT 'IN',
    category    TEXT NOT NULL,
    name        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    phone       TEXT,
    address     TEXT,
    opening_hrs TEXT,
    source      TEXT DEFAULT 'pre-seeded',
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emergency_helplines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    service_type TEXT NOT NULL,
    number       TEXT NOT NULL,
    description  TEXT,
    UNIQUE(country_code, service_type)
);

CREATE TABLE IF NOT EXISTS osm_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key   TEXT UNIQUE NOT NULL,
    lat         REAL,
    lon         REAL,
    radius_km   REAL,
    category    TEXT,
    result_json TEXT,
    fetched_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lat         REAL,
    lon         REAL,
    kind        TEXT DEFAULT 'accident',
    severity    TEXT DEFAULT 'unknown',
    location    TEXT,
    vehicles    INTEGER DEFAULT 1,
    injuries    TEXT DEFAULT 'Unknown',
    reported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS civilian_responders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    skill       TEXT NOT NULL,
    phone       TEXT,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    available   INTEGER DEFAULT 1,
    registered_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_city ON emergency_contacts(city);
CREATE INDEX IF NOT EXISTS idx_contacts_category ON emergency_contacts(category);
CREATE INDEX IF NOT EXISTS idx_contacts_country ON emergency_contacts(country);
CREATE INDEX IF NOT EXISTS idx_helplines_cc ON emergency_helplines(country_code);
CREATE INDEX IF NOT EXISTS idx_responders_loc ON civilian_responders(lat, lon);
""")

# ── Emergency Helplines ───────────────────────────────────────────────────────

helplines = [
    ("IN","police","100","Police Emergency"), ("IN","ambulance","108","Medical Emergency"),
    ("IN","fire","101","Fire Emergency"), ("IN","highway","1033","National Highway Helpline"),
    ("IN","disaster","1070","Disaster Management"), ("IN","women","1091","Women Helpline"),
    ("IN","child","1098","Child Helpline"), ("IN","railway","139","Railway Emergency"),
    ("US","police","911","Police/Fire/Medical"), ("US","ambulance","911","Medical Emergency"),
    ("US","fire","911","Fire Emergency"), ("US","highway","511","Traffic Information"),
    ("UK","police","999","Police Emergency"), ("UK","ambulance","999","Medical Emergency"),
    ("UK","fire","999","Fire Emergency"), ("UK","non_emergency","101","Police Non-Emergency"),
    ("AU","police","000","Police Emergency"), ("AU","ambulance","000","Medical Emergency"),
    ("AU","fire","000","Fire Emergency"),
    ("CA","police","911","Police/Fire/Medical"), ("CA","ambulance","911","Medical Emergency"),
    ("DE","police","110","Police Emergency"), ("DE","ambulance","112","Medical Emergency"),
    ("DE","fire","112","Fire Emergency"),
    ("FR","police","17","Police Emergency"), ("FR","ambulance","15","Medical Emergency"),
    ("FR","fire","18","Fire Emergency"),
    ("SG","police","999","Police Emergency"), ("SG","ambulance","995","Medical Emergency"),
    ("SG","fire","995","Fire Emergency"),
    ("AE","police","999","Police Emergency"), ("AE","ambulance","998","Medical Emergency"),
    ("AE","fire","997","Fire Emergency"),
    ("JP","police","110","Police Emergency"), ("JP","ambulance","119","Medical Emergency"),
    ("JP","fire","119","Fire Emergency"),
    ("CN","police","110","Police Emergency"), ("CN","ambulance","120","Medical Emergency"),
    ("CN","fire","119","Fire Emergency"),
    ("DEFAULT","police","112","Universal Emergency"), ("DEFAULT","ambulance","112","Universal Emergency"),
    ("DEFAULT","fire","112","Universal Emergency"),
]

c.executemany(
    "INSERT OR REPLACE INTO emergency_helplines (country_code, service_type, number, description) VALUES (?,?,?,?)",
    helplines
)

# ── Emergency Contacts from city_fallback.json ────────────────────────────────

fallback_path = os.path.join(os.path.dirname(__file__), "data", "city_fallback.json")
with open(fallback_path, encoding="utf-8") as f:
    city_data = json.load(f)

rows = []
for city in city_data["cities"]:
    for category, items in city["services"].items():
        for item in items:
            rows.append((
                city["name"],
                "IN",
                category,
                item["name"],
                item["lat"],
                item["lon"],
                item.get("phone", ""),
                "",
                "",
                "pre-seeded"
            ))

c.executemany("""
    INSERT INTO emergency_contacts
        (city, country, category, name, lat, lon, phone, address, opening_hrs, source)
    VALUES (?,?,?,?,?,?,?,?,?,?)
""", rows)

# ── Major Indian Trauma Centres (curated) ─────────────────────
trauma_centres = [
    # Delhi
    ("New Delhi","IN","hospital","AIIMS Trauma Centre — Level I",28.5672,77.2100,"011-26588500"),
    ("New Delhi","IN","hospital","Safdarjung Hospital Trauma",28.5665,77.2060,"011-26730000"),
    ("New Delhi","IN","hospital","Ram Manohar Lohia Hospital",28.6258,77.2003,"011-23742000"),
    ("New Delhi","IN","hospital","LNJP Hospital Trauma Centre",28.6513,77.2340,"011-23232400"),
    ("New Delhi","IN","hospital","GTB Hospital Trauma Centre",28.6774,77.3043,"011-22582505"),
    # Mumbai
    ("Mumbai","IN","hospital","KEM Hospital Trauma Unit",19.0030,72.8407,"022-24136051"),
    ("Mumbai","IN","hospital","JJ Hospital Trauma Centre",18.9596,72.8295,"022-23735555"),
    ("Mumbai","IN","hospital","Nair Hospital Trauma",18.9637,72.8337,"022-23027444"),
    ("Mumbai","IN","hospital","Sion Hospital Accident Unit",19.0386,72.8619,"022-24076381"),
    # Bangalore
    ("Bangalore","IN","hospital","Victoria Hospital Trauma",12.9598,77.5713,"080-26703101"),
    ("Bangalore","IN","hospital","NIMHANS Trauma Centre",12.9343,77.5959,"080-46110007"),
    ("Bangalore","IN","hospital","Bowring Hospital Trauma",12.9766,77.6050,"080-25460440"),
    # Chennai
    ("Chennai","IN","hospital","Rajiv Gandhi Govt General Hospital",13.0827,80.2707,"044-25305000"),
    ("Chennai","IN","hospital","Stanley Medical College Hospital",13.1016,80.2897,"044-25281232"),
    ("Chennai","IN","hospital","Kilpauk Medical College Hospital",13.0780,80.2420,"044-26422401"),
    # Hyderabad
    ("Hyderabad","IN","hospital","Osmania General Hospital Trauma",17.3680,78.4860,"040-24600354"),
    ("Hyderabad","IN","hospital","NIMS Trauma Centre",17.3910,78.4574,"040-23489000"),
    ("Hyderabad","IN","hospital","Gandhi Hospital Trauma Unit",17.4340,78.4784,"040-27505566"),
    # Kolkata
    ("Kolkata","IN","hospital","SSKM Hospital Trauma Centre",22.5392,88.3378,"033-22041601"),
    ("Kolkata","IN","hospital","NRS Medical College Trauma",22.5560,88.3624,"033-22654334"),
    ("Kolkata","IN","hospital","Calcutta Medical College",22.5768,88.3561,"033-22410870"),
]

# Insert trauma centres — skip duplicates by name
for tc in trauma_centres:
    exists = c.execute("SELECT 1 FROM emergency_contacts WHERE name=?", (tc[3],)).fetchone()
    if not exists:
        c.execute("""INSERT INTO emergency_contacts
            (city,country,category,name,lat,lon,phone,address,opening_hrs,source)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (tc[0],tc[1],tc[2],tc[3],tc[4],tc[5],tc[6],"","","trauma-seeded"))

conn.commit()

# ── Verify ────────────────────────────────────────────────────────────────────

total = c.execute("SELECT COUNT(*) FROM emergency_contacts").fetchone()[0]
hl = c.execute("SELECT COUNT(*) FROM emergency_helplines").fetchone()[0]
cats = c.execute("SELECT category, COUNT(*) FROM emergency_contacts GROUP BY category").fetchall()
cities = c.execute("SELECT city, COUNT(*) FROM emergency_contacts GROUP BY city").fetchall()

print(f"Database created: {DB_PATH}")
print(f"  emergency_contacts : {total} records")
print(f"  emergency_helplines: {hl} records")
print()
print("Contacts by category:")
for cat, n in cats:
    print(f"  {cat:20s} {n}")
print()
print("Contacts by city:")
for city, n in cities:
    print(f"  {city:20s} {n}")

conn.close()
print("\nDone. Database ready.")
