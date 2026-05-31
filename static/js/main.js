'use strict';

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
let userLat = null, userLon = null, locationReady = false;
let timerInterval = null, timerSecs = 3600;
let recognition = null, isListening = false;
let lastServicesData = null;
let leafletMap = null, miniMap = null, mapMarkers = [], miniMapMarkers = [];
let currentMapFilter = 'hospital';
let currentServiceTab = 'hospital';
let sosCountdownInterval = null;
let crashDetectionActive = false, crashCountdownInterval = null, crashCountdownSecs = 5;
let lastMagnitudes = [];
const CRASH_THRESHOLD = 22, CRASH_WINDOW = 3;
let _incidentSource = null;
let ttsActive = false;

// Triage / flow state
let triageStep = 0;
let triageData = { injured: null, unconscious: null, fire: null, breakdown: null };
const TRIAGE_FLOW = [
  { key:'injured',     q:'Is anyone injured or in pain?',
    opts:[{label:'Yes — injured', cls:'yes', val:true},{label:'No injuries', cls:'no', val:false}] },
  { key:'unconscious', q:'Is anyone unconscious or not breathing?',
    opts:[{label:'Yes — critical', cls:'yes', val:true},{label:'No — conscious', cls:'no', val:false}] },
  { key:'fire',        q:'Is there a fire, smoke, or fuel leak?',
    opts:[{label:'Yes — fire/smoke', cls:'yes', val:true},{label:'No', cls:'no', val:false}] },
  { key:'breakdown',   q:'Vehicle badly damaged or needs towing?',
    opts:[{label:'Yes', cls:'yes', val:true},{label:'No / not sure', cls:'no', val:false}] }
];

// First aid content
const FIRSTAID_CATS = [
  { key:'cpr',         label:'CPR'            },
  { key:'bleeding',    label:'Bleeding'       },
  { key:'fracture',    label:'Fracture'       },
  { key:'burn',        label:'Burns'          },
  { key:'unconscious', label:'Unconscious'    },
  { key:'choking',     label:'Choking'        },
  { key:'accident',    label:'Accident'       },
  { key:'fire',        label:'Fire Emergency' },
];

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  initOnlineStatus();
  silentLocate();
  initVoice();
  loadMedProfileDisplay();
  loadDocVaultDisplay();
  setLogDateTime();
  showView('home');
});

function setLogDateTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  const el = document.getElementById('logTime');
  if (el) el.value = now.toISOString().slice(0, 16);
}

function initOnlineStatus() {
  const banner = document.getElementById('offlineBanner');
  const update = () => { banner.style.display = navigator.onLine ? 'none' : 'flex'; };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ═══════════════════════════════════════════════════════════════
//  LOCATION
// ═══════════════════════════════════════════════════════════════
function silentLocate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => setLocation(pos.coords.latitude, pos.coords.longitude, true),
    () => {}, { timeout: 6000, maximumAge: 60000 }
  );
}

function setLocation(lat, lon, silent = false) {
  userLat = lat; userLon = lon; locationReady = true;
  const locText = document.getElementById('locText');
  if (locText) locText.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const locInd = document.getElementById('locIndicator');
  if (locInd) locInd.className = 'loc-indicator on';
  const locBtn = document.getElementById('locBtn');
  if (locBtn) locBtn.style.borderColor = 'rgba(48,209,88,.4)';
  const logLoc = document.getElementById('logLoc');
  if (logLoc) logLoc.value = `${lat.toFixed(5)}, ${lon.toFixed(5)} — maps.google.com/?q=${lat},${lon}`;
  localStorage.setItem('roadsos_lat', lat);
  localStorage.setItem('roadsos_lon', lon);
  onLocationReady();
  loadHomeStats();
  if (!silent) addBotMsg('Location captured. I can now find emergency services near you.');
}

function requestLocation() {
  if (!navigator.geolocation) { addBotMsg('Geolocation is not supported.'); return; }
  const locText = document.getElementById('locText');
  if (locText) locText.textContent = 'Locating…';
  const locInd = document.getElementById('locIndicator');
  if (locInd) locInd.className = 'loc-indicator locating';
  navigator.geolocation.getCurrentPosition(
    pos => setLocation(pos.coords.latitude, pos.coords.longitude),
    () => {
      if (locText) locText.textContent = 'Share Location';
      if (locInd) locInd.className = 'loc-indicator';
      addBotMsg('Could not get location. Please allow location access in browser settings.');
    },
    { timeout: 12000, enableHighAccuracy: true }
  );
}

function onLocationReady() {
  startIncidentFeed();
}

// ═══════════════════════════════════════════════════════════════
//  VIEW MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function showView(name) {
  const views = ['home', 'map', 'nearby', 'assist', 'profile'];
  views.forEach(v => {
    const el = document.getElementById(`v-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  views.forEach(v => {
    const tab = document.getElementById(`nav-${v}`);
    if (tab) tab.classList.toggle('active', v === name);
  });
  if (name === 'map') initMainMap();
  if (name === 'nearby' && !document.querySelector('#serviceList .svc-card')) {
    switchServiceTab(currentServiceTab, document.querySelector('.stab.active'));
  }
}

// ═══════════════════════════════════════════════════════════════
//  SOS FLOW
// ═══════════════════════════════════════════════════════════════
function initSOS() {
  document.getElementById('sosOverlay').style.display = 'flex';
  // Reset checklist
  for (let i = 1; i <= 4; i++) {
    const chk = document.getElementById(`chk-${i}`);
    if (chk) { chk.classList.remove('done'); chk.textContent = ''; }
    const item = document.getElementById(`sai-${i}`);
    if (item) item.classList.remove('active');
  }
  // Animate items in
  let delay = 150;
  for (let i = 1; i <= 4; i++) {
    ((idx) => setTimeout(() => {
      const item = document.getElementById(`sai-${idx}`);
      if (item) item.classList.add('active');
    }, delay))(i);
    delay += 200;
  }
  // Auto-confirm countdown (5s)
  let secs = 5;
  const badge = document.getElementById('sosCountdownBadge');
  const confirmBtn = document.getElementById('sosConfirmBtn');
  if (badge) { badge.style.display = 'inline-flex'; badge.textContent = secs; }

  sosCountdownInterval = setInterval(() => {
    secs--;
    if (badge) badge.textContent = secs;
    if (secs <= 0) {
      clearInterval(sosCountdownInterval);
      confirmSOS();
    }
  }, 1000);
}

function cancelSOS() {
  clearInterval(sosCountdownInterval);
  document.getElementById('sosOverlay').style.display = 'none';
  const badge = document.getElementById('sosCountdownBadge');
  if (badge) badge.style.display = 'none';
}

function confirmSOS() {
  clearInterval(sosCountdownInterval);
  document.getElementById('sosOverlay').style.display = 'none';
  const badge = document.getElementById('sosCountdownBadge');
  if (badge) badge.style.display = 'none';

  // Animate checklist checks
  for (let i = 1; i <= 4; i++) {
    ((idx) => setTimeout(() => {
      const chk = document.getElementById(`chk-${idx}`);
      const item = document.getElementById(`sai-${idx}`);
      if (chk) { chk.classList.add('done'); chk.textContent = '✓'; }
      if (item) item.classList.add('checked');
    }, idx * 100))(i);
  }

  // Get location if needed then fire SOS
  if (!locationReady) {
    navigator.geolocation?.getCurrentPosition(
      pos => { setLocation(pos.coords.latitude, pos.coords.longitude, true); callSOS(); },
      () => { showResults(); addBotMsg('Location unavailable. Call 112 immediately.'); },
      { timeout: 10000, enableHighAccuracy: true }
    );
    return;
  }
  callSOS();
}

function callSOS() {
  showResults('SOS — Emergency services alerted');
  startGoldenTimer();
  autoAlertContacts();
  showView('assist');

  const tid = addTyping();
  Promise.all([
    fetch('/api/sos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: userLat, lon: userLon })
    }).then(r => r.json()),
    fetch('/api/nearby_responders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: userLat, lon: userLon })
    }).then(r => r.json()).catch(() => ({ responders: [] }))
  ])
  .then(([sosData, respData]) => {
    removeTyping(tid);
    showEmergencyDashboard(sosData);
    renderServices(sosData, respData.responders || []);
    updateHelplineStrip(sosData.emergency_numbers, sosData.country_code);
  })
  .catch(() => { removeTyping(tid); addBotMsg('Network error. Call 112 immediately.'); });
}

// ═══════════════════════════════════════════════════════════════
//  FLOW OVERLAY (Accident / Breakdown / First Aid)
// ═══════════════════════════════════════════════════════════════
function startFlow(type) {
  if (type === 'firstaid') {
    openFirstAid();
    return;
  }
  const overlay = document.getElementById('flowOverlay');
  const content = document.getElementById('flowContent');
  overlay.style.display = 'flex';

  if (type === 'accident') {
    triageStep = 0;
    triageData = { injured: null, unconscious: null, fire: null, breakdown: null };
    renderTriageStep(content);
  } else if (type === 'breakdown') {
    renderBreakdownFlow(content);
  }
}

function closeFlow() {
  document.getElementById('flowOverlay').style.display = 'none';
}

function handleFlowBackdrop(e) {
  if (e.target === document.getElementById('flowOverlay')) closeFlow();
}

function renderTriageStep(container) {
  const step = TRIAGE_FLOW[triageStep];
  if (!step) { closeFlow(); finishTriage(); return; }
  container.innerHTML = `
    <h2 class="flow-title">Report Accident</h2>
    <div class="flow-progress">Step ${triageStep + 1} of ${TRIAGE_FLOW.length}</div>
    <div class="flow-question">${step.q}</div>
    <div class="flow-opts">
      ${step.opts.map(o => `
        <button class="flow-opt ${o.cls}" onclick="answerTriage(${o.val})">
          ${o.label}
        </button>`).join('')}
    </div>
    <button class="flow-cancel" onclick="closeFlow()">Cancel</button>`;
}

function answerTriage(val, label) {
  const step = TRIAGE_FLOW[triageStep];
  triageData[step.key] = val;
  triageStep++;
  const content = document.getElementById('flowContent');
  if (triageStep < TRIAGE_FLOW.length) {
    renderTriageStep(content);
  } else {
    closeFlow();
    finishTriage();
  }
}

function finishTriage() {
  const score = calcSeverityScore(triageData);
  const lbl = severityLabel(score);

  showView('assist');
  showResults('Accident reported');
  addBotMsg(`Severity ${score}/10 — ${lbl.text}. Routing to appropriate services…`);

  let services = ['hospital', 'ambulance', 'police'];
  let faKey = 'accident';

  if (triageData.unconscious) {
    faKey = 'unconscious';
    addBotMsg('Critical — dispatching priority services. Check breathing, start CPR if trained. Do NOT move the person.');
  } else if (triageData.fire) {
    faKey = 'fire';
    services = ['fire_station', 'hospital', 'ambulance', 'police'];
    addBotMsg('Fire emergency — evacuate everyone at least 50 metres away immediately.');
  } else if (triageData.injured) {
    addBotMsg('Finding nearest trauma hospitals and ambulance services…');
  } else if (triageData.breakdown) {
    services = ['vehicle_repair', 'towing', 'puncture', 'police'];
    addBotMsg('Vehicle breakdown — finding nearest mechanics, towing, and police.');
  }

  if (!locationReady) { addBotMsg('Please share your location first.'); return; }
  startGoldenTimer();
  const tid = addTyping();
  fetch('/api/triage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: userLat, lon: userLon, services, fa_key: faKey })
  })
  .then(r => r.json())
  .then(d => { removeTyping(tid); renderServices(d); updateHelplineStrip(d.emergency_numbers, d.country_code); })
  .catch(() => { removeTyping(tid); addBotMsg('Network error. Call 112 immediately.'); });
}

function renderBreakdownFlow(container) {
  container.innerHTML = `
    <h2 class="flow-title">Vehicle Breakdown</h2>
    <p class="flow-sub">What best describes your situation?</p>
    <div class="flow-opts">
      <button class="flow-opt" onclick="closeFlow();quickFind('vehicle_repair')">Engine / Mechanical fault</button>
      <button class="flow-opt" onclick="closeFlow();quickFind('puncture')">Flat tyre / Puncture</button>
      <button class="flow-opt" onclick="closeFlow();quickFind('towing')">Need towing</button>
      <button class="flow-opt" onclick="closeFlow();quickFind('vehicle_repair')">Battery / Electrical issue</button>
      <button class="flow-opt" onclick="closeFlow();quickFind('showroom')">Nearest car showroom</button>
    </div>
    <button class="flow-cancel" onclick="closeFlow()">Cancel</button>`;
}

// ═══════════════════════════════════════════════════════════════
//  RESULTS OVERLAY
// ═══════════════════════════════════════════════════════════════
function showResults(meta) {
  const overlay = document.getElementById('resultsOverlay');
  overlay.style.display = 'flex';
  if (meta) document.getElementById('resultsMeta').textContent = meta;
}

function closeResults() {
  document.getElementById('resultsOverlay').style.display = 'none';
}

function handleResultsBackdrop(e) {
  if (e.target === document.getElementById('resultsOverlay')) closeResults();
}

let miniMapVisible = false;
function toggleResultsMap() {
  miniMapVisible = !miniMapVisible;
  const mini = document.getElementById('resultsMiniMap');
  const btn = document.getElementById('resultsMapBtn');
  mini.style.display = miniMapVisible ? 'block' : 'none';
  if (btn) btn.textContent = miniMapVisible ? 'Hide Map' : 'Map';
  if (miniMapVisible) {
    if (!miniMap && userLat) initMiniMap();
    else if (miniMap) setTimeout(() => miniMap.invalidateSize(), 50);
  }
}

function initMiniMap() {
  if (!userLat || miniMap) return;
  miniMap = L.map('miniLeafletMap', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OSM', maxZoom: 18
  }).addTo(miniMap);
  miniMap.setView([userLat, userLon], 13);
  const userIcon = L.divIcon({
    html: '<div style="background:#FF453A;width:12px;height:12px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 8px rgba(255,69,58,.7)"></div>',
    className: '', iconSize: [12, 12], iconAnchor: [6, 6]
  });
  L.marker([userLat, userLon], { icon: userIcon }).addTo(miniMap).bindPopup('<strong>You</strong>');
}

// ═══════════════════════════════════════════════════════════════
//  RENDER SERVICES
// ═══════════════════════════════════════════════════════════════
function renderServices(data, responders = []) {
  showResults();
  const cards = document.getElementById('resultsCards');
  cards.innerHTML = '';

  const svcs = data.services || {};
  let totalFound = 0;
  for (const items of Object.values(svcs)) totalFound += (items || []).length;
  document.getElementById('resultsMeta').textContent =
    `${data.location_short || ''} · ${totalFound} result${totalFound !== 1 ? 's' : ''}`;

  // Helplines card
  const numbers = data.emergency_numbers || {};
  if (Object.keys(numbers).length) {
    const hlItems = Object.entries(numbers).map(([k, v]) =>
      `<a href="tel:${v.replace(/\s/g, '')}" class="hl-item">
        <span class="hl-name">${k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ')}</span>
        <span class="hl-num">${v}</span>
      </a>`
    ).join('');
    const hlCard = document.createElement('div');
    hlCard.className = 'helplines-card';
    hlCard.innerHTML = `<div class="helplines-card-title">Emergency Helplines — Tap to Call</div>
      <div class="helplines-grid">${hlItems}</div>`;
    cards.appendChild(hlCard);
  }

  // Priority card (nearest hospital/ambulance)
  const hospitals = svcs['hospital'] || [];
  const ambulances = svcs['ambulance'] || [];
  const closest = hospitals[0] || ambulances[0];
  if (closest) {
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${closest.lat},${closest.lon}`;
    const callHtml = closest.phone
      ? `<a href="tel:${closest.phone.replace(/\s/g,'')}" class="btn-call-big">Call — ${closest.phone}</a>`
      : `<a href="tel:108" class="btn-call-big">Call Ambulance — 108</a>`;
    const pCard = document.createElement('div');
    pCard.className = 'priority-card';
    pCard.innerHTML = `
      <div class="priority-tag">Nearest ${esc(closest.label || 'Service')}</div>
      <div class="priority-name">${esc(closest.name)}</div>
      <div class="priority-dist">${closest.distance_km} km away</div>
      <div class="priority-actions">
        ${callHtml}
        <a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-nav-big">Navigate</a>
      </div>`;
    cards.appendChild(pCard);
  }

  // First aid steps
  if (data.first_aid && data.first_aid.steps && data.first_aid.steps.length) {
    const faCard = document.createElement('div');
    faCard.className = 'fa-result-card';
    faCard.innerHTML = `<div class="fa-result-title">${esc(data.first_aid.title || 'First Aid')}</div>
      <ol class="fa-steps">${data.first_aid.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
    cards.appendChild(faCard);
  }

  // Service sections
  let hasSections = false;
  for (const [key, items] of Object.entries(svcs)) {
    if (!items || !items.length) continue;
    hasSections = true;
    const section = document.createElement('div');
    section.className = 'svc-section';
    const itemCards = items.map(item => {
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
      const phoneHtml = item.phone
        ? `<div class="svc-card-phone"><a href="tel:${item.phone.replace(/\s/g, '')}">${esc(item.phone)}</a></div>` : '';
      const distClass = parseFloat(item.distance_km) > 15 ? 'far' : '';
      return `<div class="svc-card">
        <div class="svc-card-info">
          <div class="svc-card-name">${esc(item.name)}</div>
          ${phoneHtml}
        </div>
        <span class="svc-card-dist ${distClass}">${item.distance_km} km</span>
        <a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-nav">Navigate</a>
      </div>`;
    }).join('');
    section.innerHTML = `<div class="svc-section-title">${esc((items[0]?.label || key).toUpperCase())}</div>${itemCards}`;
    cards.appendChild(section);
  }

  if (!hasSections && !closest) {
    cards.innerHTML += `<div class="no-results">No services found nearby. Use helplines above or call 112.</div>`;
  }

  if (responders.length) renderResponders(responders, cards);

  lastServicesData = data;
  buildMiniMapMarkers(data);
  try { localStorage.setItem('roadsos_last', JSON.stringify(data)); } catch (_) {}
}

function renderResponders(responders, container) {
  const section = document.createElement('div');
  section.className = 'responders-section';
  section.innerHTML = `<div class="responders-title">Civilian First Responders Nearby</div>` +
    responders.map(r => `
      <div class="responder-card">
        <div class="responder-info">
          <div class="responder-name">${esc(r.name)}</div>
          <div class="responder-skill">${esc(r.skill)}</div>
        </div>
        <span class="responder-dist">${r.distance_km} km</span>
        ${r.phone ? `<a href="tel:${r.phone.replace(/\s/g,'')}" class="responder-call">Call</a>` : ''}
      </div>`).join('');
  container.appendChild(section);
}

function buildMiniMapMarkers(data) {
  if (!miniMap || !data.lat) return;
  miniMapMarkers.forEach(m => miniMap.removeLayer(m));
  miniMapMarkers = [];
  const colors = {
    hospital:'#FF453A', ambulance:'#FF9F0A', police:'#0A84FF',
    fire_station:'#FF3B30', vehicle_repair:'#30D158', towing:'#BF5AF2',
    pharmacy:'#64D2FF', towing:'#BF5AF2'
  };
  const bounds = [[data.lat, data.lon]];
  if (data.services) {
    for (const [key, items] of Object.entries(data.services)) {
      if (!items) continue;
      const color = colors[key] || '#888';
      items.forEach(item => {
        const icon = L.divIcon({
          html: `<div style="background:${color};color:#fff;padding:3px 7px;border-radius:10px;font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4)">${item.distance_km}km</div>`,
          className: '', iconAnchor: [0, 0]
        });
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
        const m = L.marker([item.lat, item.lon], { icon }).addTo(miniMap)
          .bindPopup(`<strong>${item.name}</strong><br>${item.distance_km} km<br><a href="${mapsUrl}" target="_blank">Navigate</a>`);
        miniMapMarkers.push(m);
        bounds.push([item.lat, item.lon]);
      });
    }
  }
  miniMap.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
}

// ═══════════════════════════════════════════════════════════════
//  NEARBY SERVICES VIEW
// ═══════════════════════════════════════════════════════════════
function switchServiceTab(type, el) {
  currentServiceTab = type;
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');

  // Show/hide blood type filter
  const bloodFilter = document.getElementById('bloodFilter');
  if (bloodFilter) bloodFilter.style.display = type === 'blood_bank' ? 'flex' : 'none';

  // Auto-select user's blood type
  if (type === 'blood_bank') {
    const p = loadMedProfile();
    if (p && p.blood) {
      const pill = Array.from(document.querySelectorAll('.bt-pill'))
        .find(b => b.textContent.trim() === p.blood);
      if (pill) setBloodFilter(p.blood, pill);
    }
  }

  if (!locationReady) {
    document.getElementById('serviceList').innerHTML =
      `<div class="empty-state"><p>Share your location first</p><button class="btn-primary-sm" onclick="requestLocation()">Enable Location</button></div>`;
    return;
  }

  const list = document.getElementById('serviceList');
  const label = type === 'blood_bank' ? 'blood banks' : `${type} services`;
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Finding ${label}…</span></div>`;

  fetch(`/api/nearby/${type}?lat=${userLat}&lon=${userLon}&radius=25`)
    .then(r => r.json())
    .then(d => {
      const items = d.results || d.services?.[type] || [];
      if (type === 'blood_bank') renderBloodList(items);
      else renderNearbyList(type, d);
    })
    .catch(() => {
      list.innerHTML = `<div class="empty-state"><p>Error loading services. Try again.</p></div>`;
    });
}

function refreshNearby() {
  const activeTab = document.querySelector('.stab.active');
  switchServiceTab(currentServiceTab, activeTab);
}

function renderNearbyList(type, data) {
  const list = document.getElementById('serviceList');
  const items = data.results || data.services?.[type] || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><p>No ${type} found nearby.<br>Try expanding search area.</p></div>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
    const phoneHtml = item.phone
      ? `<a href="tel:${item.phone.replace(/\s/g,'')}" class="svc-card-call">${esc(item.phone)}</a>` : '';
    return `<div class="svc-card">
      <div class="svc-card-info">
        <div class="svc-card-name">${esc(item.name)}</div>
        ${phoneHtml}
      </div>
      <span class="svc-card-dist ${parseFloat(item.distance_km) > 15 ? 'far' : ''}">${item.distance_km} km</span>
      <a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-nav">Navigate</a>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
//  QUICK FIND (breakdown options)
// ═══════════════════════════════════════════════════════════════
function quickFind(type) {
  const labels = {
    hospital:'nearest hospital', police:'nearest police station',
    ambulance:'nearest ambulance', vehicle_repair:'vehicle mechanic',
    towing:'towing service', puncture:'tyre and puncture shop',
    showroom:'car showroom', pharmacy:'nearest pharmacy'
  };
  showView('assist');
  addBotMsg(`Finding ${labels[type] || type} near you…`);
  if (!locationReady) { addBotMsg('Please share your location first.'); return; }
  const tid = addTyping();
  fetch('/api/quick', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: userLat, lon: userLon, type })
  })
  .then(r => r.json())
  .then(d => { removeTyping(tid); renderServices(d); updateHelplineStrip(d.emergency_numbers, d.country_code); })
  .catch(() => { removeTyping(tid); addBotMsg('Error fetching data. Try again.'); });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN MAP VIEW
// ═══════════════════════════════════════════════════════════════
function initMainMap() {
  if (leafletMap) { setTimeout(() => leafletMap.invalidateSize(), 100); return; }
  const center = userLat ? [userLat, userLon] : [20.5937, 78.9629];
  leafletMap = L.map('leafletMap', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18
  }).addTo(leafletMap);
  leafletMap.setView(center, userLat ? 13 : 5);
  if (userLat) addUserMarker();
  if (locationReady) loadMapFilter(currentMapFilter);
}

function addUserMarker() {
  if (!leafletMap || !userLat) return;
  const icon = L.divIcon({
    html: '<div style="background:#FF453A;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 10px rgba(255,69,58,.8)"></div>',
    className: '', iconSize: [14, 14], iconAnchor: [7, 7]
  });
  L.marker([userLat, userLon], { icon }).addTo(leafletMap).bindPopup('<strong style="color:#FF453A">Your Location</strong>');
}

function filterMap(type, el) {
  currentMapFilter = type;
  document.querySelectorAll('.map-filter').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  loadMapFilter(type);
}

function loadMapFilter(type) {
  if (!leafletMap || !locationReady) return;
  mapMarkers.forEach(m => leafletMap.removeLayer(m));
  mapMarkers = [];
  fetch(`/api/nearby/${type}?lat=${userLat}&lon=${userLon}&radius=25`)
    .then(r => r.json())
    .then(d => {
      const items = d.results || d.services?.[type] || [];
      const colors = {
        hospital:'#FF453A', ambulance:'#FF9F0A', police:'#0A84FF',
        fire_station:'#FF3B30', vehicle_repair:'#30D158', towing:'#BF5AF2',
        pharmacy:'#64D2FF'
      };
      const color = colors[type] || '#888';
      items.forEach(item => {
        const icon = L.divIcon({
          html: `<div style="background:${color};color:#fff;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)">${item.distance_km}km</div>`,
          className: '', iconAnchor: [0, 0]
        });
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
        const phoneStr = item.phone ? `<br><a href="tel:${item.phone.replace(/\s/g,'')}">${item.phone}</a>` : '';
        const m = L.marker([item.lat, item.lon], { icon }).addTo(leafletMap)
          .bindPopup(`<strong>${item.name}</strong>${phoneStr}<br><b>${item.distance_km} km</b><br><a href="${mapsUrl}" target="_blank">Navigate →</a>`);
        mapMarkers.push(m);
      });
    })
    .catch(() => {});
}

function recenterMap() {
  if (!leafletMap || !userLat) return;
  leafletMap.setView([userLat, userLon], 13);
}

// ═══════════════════════════════════════════════════════════════
//  FIRST AID OVERLAY
// ═══════════════════════════════════════════════════════════════
function openFirstAid() {
  document.getElementById('firstaidOverlay').style.display = 'flex';
  document.getElementById('firstaidTitle').textContent = 'First Aid';
  renderFirstAidCategories();
}

function closeFirstAid() {
  document.getElementById('firstaidOverlay').style.display = 'none';
  window.speechSynthesis?.cancel();
  ttsActive = false;
}

function renderFirstAidCategories() {
  const body = document.getElementById('firstaidBody');
  body.innerHTML = `
    <p class="fa-intro">Select a situation for step-by-step guidance</p>
    <div class="fa-cat-grid">
      ${FIRSTAID_CATS.map(c => `
        <button class="fa-cat-card" onclick="openFirstAidGuide('${c.key}')">
          <span class="fa-cat-label">${c.label}</span>
        </button>`).join('')}
    </div>`;
}

function openFirstAidGuide(key) {
  document.getElementById('firstaidTitle').textContent = 'Loading…';
  document.getElementById('firstaidBody').innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading guide…</span></div>`;
  fetch(`/api/first_aid/${key}`)
    .then(r => r.json())
    .then(d => {
      document.getElementById('firstaidTitle').textContent = d.title || 'First Aid';
      const body = document.getElementById('firstaidBody');
      body.innerHTML = `
        <button class="fa-back-btn" onclick="renderFirstAidCategories();document.getElementById('firstaidTitle').textContent='First Aid'">
          ← All Categories
        </button>
        <div class="fa-guide-title">${esc(d.title || '')}</div>
        <ol class="fa-steps-guide">
          ${(d.steps || []).map((s, i) => `<li><span class="fa-step-num">${i + 1}</span>${esc(s)}</li>`).join('')}
        </ol>`;
    })
    .catch(() => {
      document.getElementById('firstaidBody').innerHTML = `<div class="empty-state"><p>Guide unavailable. Call 108 now.</p></div>`;
    });
}

function speakFirstAid() {
  if (!window.speechSynthesis) return;
  if (ttsActive) {
    window.speechSynthesis.cancel(); ttsActive = false;
    document.getElementById('speakBtn').style.opacity = '1';
    return;
  }
  const text = document.getElementById('firstaidBody')?.innerText || '';
  if (!text) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-IN'; utt.rate = 0.9;
  utt.onend = () => { ttsActive = false; document.getElementById('speakBtn').style.opacity = '1'; };
  window.speechSynthesis.speak(utt);
  ttsActive = true;
  document.getElementById('speakBtn').style.opacity = '0.5';
}

// ═══════════════════════════════════════════════════════════════
//  CHAT / AI ASSISTANT
// ═══════════════════════════════════════════════════════════════
function sendMessage() {
  const input = document.getElementById('msgInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  sendText(msg);
}

function sendText(msg) {
  showView('assist');
  addUserMsg(msg);
  const tid = addTyping();
  fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, lat: userLat, lon: userLon })
  })
  .then(r => r.json())
  .then(d => {
    removeTyping(tid);
    if (d.type === 'greeting' || d.type === 'request_location') {
      addBotMsg(d.text);
    } else if (d.type === 'first_aid') {
      addBotMsg(d.text || `Here's guidance for: ${d.title}`);
      showResults(d.title);
      const cards = document.getElementById('resultsCards');
      const div = document.createElement('div');
      div.className = 'fa-result-card';
      div.innerHTML = `<div class="fa-result-title">${esc(d.title)}</div>
        <ol class="fa-steps">${(d.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
      cards.innerHTML = '';
      cards.appendChild(div);
    } else if (d.type === 'services' || d.type === 'sos') {
      if (d.text) addBotMsg(d.text);
      renderServices(d);
      updateHelplineStrip(d.emergency_numbers, d.country_code);
    } else if (d.text) {
      addBotMsg(d.text);
    }
  })
  .catch(() => { removeTyping(tid); addBotMsg('Connection error. Try again or call 112.'); });
}

function addBotMsg(text) {
  const area = document.getElementById('chatArea');
  // Remove welcome screen on first message
  const welcome = area.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg-bot';
  div.innerHTML = `<div class="msg-bot-avatar">R</div><div class="msg-bot-bubble">${esc(text)}</div>`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function addUserMsg(text) {
  const area = document.getElementById('chatArea');
  const welcome = area.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg-user';
  div.innerHTML = `<div class="msg-user-bubble">${esc(text)}</div>`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function addTyping() {
  const area = document.getElementById('chatArea');
  const welcome = area.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';
  const id = 'typ-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg-bot'; div.id = id;
  div.innerHTML = `<div class="msg-bot-avatar">R</div><div class="msg-bot-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
  return id;
}

function removeTyping(id) { document.getElementById(id)?.remove(); }

// ═══════════════════════════════════════════════════════════════
//  HELPLINE STRIP
// ═══════════════════════════════════════════════════════════════
function updateHelplineStrip(numbers, cc) {
  if (!numbers) return;
  const strip = document.getElementById('helplineStrip');
  if (!strip) return;
  // Keep existing static chips, but update if location-based numbers differ
  localStorage.setItem('roadsos_helplines', JSON.stringify({ numbers, cc }));
}

// ═══════════════════════════════════════════════════════════════
//  GOLDEN HOUR TIMER
// ═══════════════════════════════════════════════════════════════
function startGoldenTimer() {
  if (timerInterval) return;
  timerSecs = 3600;
  document.getElementById('goldenBar').style.display = 'flex';
  timerInterval = setInterval(() => {
    timerSecs--;
    const m = String(Math.floor(timerSecs / 60)).padStart(2, '0');
    const s = String(timerSecs % 60).padStart(2, '0');
    const el = document.getElementById('timerValue');
    if (el) {
      el.textContent = `${m}:${s}`;
      if (timerSecs <= 600) el.classList.add('urgent');
    }
    if (timerSecs <= 0) stopTimer();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval); timerInterval = null;
  document.getElementById('goldenBar').style.display = 'none';
  const el = document.getElementById('timerValue');
  if (el) { el.classList.remove('urgent'); el.textContent = '60:00'; }
  timerSecs = 3600;
}

// ═══════════════════════════════════════════════════════════════
//  THEME TOGGLE
// ═══════════════════════════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  localStorage.setItem('roadsos_theme', isDark ? 'light' : 'dark');
  // Re-tile maps with correct filter (handled via CSS)
  if (leafletMap) leafletMap.invalidateSize();
  if (miniMap) miniMap.invalidateSize();
}

// Restore saved theme
(function() {
  const saved = localStorage.getItem('roadsos_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

// ═══════════════════════════════════════════════════════════════
//  SHARE / COPY
// ═══════════════════════════════════════════════════════════════
function shareWhatsApp() {
  if (!locationReady) { alert('Share your location first.'); return; }
  const mapsUrl = `https://www.google.com/maps?q=${userLat},${userLon}`;
  let msg = `RoadSoS Emergency Alert\nLocation: ${mapsUrl}`;
  if (lastServicesData?.emergency_numbers) {
    const n = lastServicesData.emergency_numbers;
    if (n.ambulance) msg += `\nAmbulance: ${n.ambulance}`;
    if (n.police) msg += `\nPolice: ${n.police}`;
  }
  const medText = getMedProfileText();
  if (medText) msg += '\n\n' + medText;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function copyLocation() {
  if (!locationReady) { alert('Share your location first.'); return; }
  navigator.clipboard.writeText(`https://www.google.com/maps?q=${userLat},${userLon}`)
    .then(() => alert('Location copied to clipboard.'));
}

// ═══════════════════════════════════════════════════════════════
//  MEDICAL PROFILE
// ═══════════════════════════════════════════════════════════════
function openMedModal() {
  const p = loadMedProfile();
  if (p) {
    ['mpName','mpBlood','mpAllergies','mpMeds','mpConditions','mpContactName','mpContactPhone'].forEach(id => {
      const el = document.getElementById(id);
      const key = id.replace('mp','').toLowerCase();
      const map = { name:'name', blood:'blood', allergies:'allergies', meds:'meds',
                    conditions:'conditions', contactname:'contactName', contactphone:'contactPhone' };
      if (el && p[map[key] || key]) el.value = p[map[key] || key];
    });
  }
  document.getElementById('medModal').style.display = 'flex';
}

function closeMedModal() {
  document.getElementById('medModal').style.display = 'none';
}

function saveMedProfile() {
  const p = {
    name:         document.getElementById('mpName').value.trim(),
    blood:        document.getElementById('mpBlood').value,
    allergies:    document.getElementById('mpAllergies').value.trim(),
    meds:         document.getElementById('mpMeds').value.trim(),
    conditions:   document.getElementById('mpConditions').value.trim(),
    contactName:  document.getElementById('mpContactName').value.trim(),
    contactPhone: document.getElementById('mpContactPhone').value.trim(),
  };
  localStorage.setItem('roadsos_med_profile', JSON.stringify(p));
  closeMedModal();
  loadMedProfileDisplay();
  addBotMsg(`Medical profile saved. Blood type: ${p.blood || 'not set'}. Emergency contact: ${p.contactName || 'not set'}.`);
}

function loadMedProfile() {
  try { return JSON.parse(localStorage.getItem('roadsos_med_profile') || 'null'); } catch (_) { return null; }
}

function getMedProfileText() {
  const p = loadMedProfile();
  if (!p) return '';
  const lines = ['MEDICAL PROFILE:'];
  if (p.name)        lines.push(`Name: ${p.name}`);
  if (p.blood)       lines.push(`Blood Type: ${p.blood}`);
  if (p.allergies)   lines.push(`Allergies: ${p.allergies}`);
  if (p.meds)        lines.push(`Medications: ${p.meds}`);
  if (p.conditions)  lines.push(`Conditions: ${p.conditions}`);
  if (p.contactName) lines.push(`Emergency Contact: ${p.contactName} — ${p.contactPhone}`);
  return lines.join('\n');
}

function loadMedProfileDisplay() {
  const p = loadMedProfile();
  const sub = document.getElementById('medProfileSub');
  const badges = document.getElementById('medBadges');
  const contactPreview = document.getElementById('emergencyContactPreview');
  if (!p) return;
  if (sub) sub.textContent = p.name ? `${p.name}${p.blood ? ' · ' + p.blood : ''}` : 'Tap to complete';
  if (badges) {
    badges.innerHTML = '';
    if (p.blood) badges.innerHTML += `<span class="med-badge blood">${p.blood}</span>`;
    if (p.allergies) badges.innerHTML += `<span class="med-badge allergy">⚠ ${p.allergies}</span>`;
    if (p.conditions) badges.innerHTML += `<span class="med-badge condition">${p.conditions}</span>`;
  }
  if (contactPreview && p.contactName) {
    contactPreview.innerHTML = `<div class="contact-preview">${esc(p.contactName)} · ${esc(p.contactPhone || '')}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════
//  RESPONDER MODAL
// ═══════════════════════════════════════════════════════════════
function openResponderModal() {
  document.getElementById('responderModal').style.display = 'flex';
}

function closeResponderModal() {
  document.getElementById('responderModal').style.display = 'none';
}

function submitResponder() {
  const name = document.getElementById('rName').value.trim();
  const skill = document.getElementById('rSkill').value;
  const phone = document.getElementById('rPhone').value.trim();
  if (!name) { alert('Please enter your name.'); return; }
  if (!locationReady) { alert('Please share your location first.'); return; }
  fetch('/api/register_responder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, skill, phone, lat: userLat, lon: userLon })
  })
  .then(r => r.json())
  .then(d => { closeResponderModal(); addBotMsg(d.message || 'Registered as first responder.'); })
  .catch(() => { closeResponderModal(); addBotMsg('Registration saved locally.'); });
}

// ═══════════════════════════════════════════════════════════════
//  ACCIDENT LOG MODAL
// ═══════════════════════════════════════════════════════════════
function openLogModal() {
  setLogDateTime();
  document.getElementById('logModal').style.display = 'flex';
}

function closeLogModal() {
  document.getElementById('logModal').style.display = 'none';
}

function submitAccidentLog() {
  const report = {
    time:        document.getElementById('logTime').value,
    type:        document.getElementById('logType').value,
    vehicles:    document.getElementById('logVehicles').value,
    injuries:    document.getElementById('logInjuries').value,
    description: document.getElementById('logDesc').value,
    location:    document.getElementById('logLoc').value,
    lat: userLat, lon: userLon,
    saved_at: new Date().toISOString()
  };
  const logs = JSON.parse(localStorage.getItem('roadsos_accident_logs') || '[]');
  logs.push(report);
  localStorage.setItem('roadsos_accident_logs', JSON.stringify(logs));
  closeLogModal();
  addBotMsg(`Accident report saved. Type: ${report.type} | Injuries: ${report.injuries}`);
}

// ═══════════════════════════════════════════════════════════════
//  VOICE
// ═══════════════════════════════════════════════════════════════
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const btn = document.getElementById('voiceBtn');
    if (btn) btn.style.display = 'none';
    return;
  }
  recognition = new SR();
  recognition.continuous = false; recognition.interimResults = false; recognition.lang = 'en-IN';
  recognition.onresult = e => {
    document.getElementById('msgInput').value = e.results[0][0].transcript;
    stopVoice(); sendMessage();
  };
  recognition.onend = () => stopVoice();
  recognition.onerror = () => stopVoice();
}

function toggleVoice() { isListening ? stopVoice() : startVoice(); }

function startVoice() {
  if (!recognition) return;
  recognition.start(); isListening = true;
  document.getElementById('voiceBtn').classList.add('listening');
  document.getElementById('msgInput').placeholder = 'Listening…';
}

function stopVoice() {
  try { recognition?.stop(); } catch (_) {}
  isListening = false;
  const btn = document.getElementById('voiceBtn');
  if (btn) btn.classList.remove('listening');
  const inp = document.getElementById('msgInput');
  if (inp) inp.placeholder = 'Describe your emergency…';
}

// ═══════════════════════════════════════════════════════════════
//  CRASH DETECTION
// ═══════════════════════════════════════════════════════════════
function toggleCrashDetection() {
  if (crashDetectionActive) { disableCrashDetection(); return; }
  if (typeof DeviceMotionEvent === 'undefined') {
    addBotMsg('Crash detection requires a mobile device with accelerometer.'); return;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(s => { if (s === 'granted') enableCrashDetection(); else addBotMsg('Motion permission denied.'); })
      .catch(() => addBotMsg('Could not request motion permission.'));
  } else {
    enableCrashDetection();
  }
}

function enableCrashDetection() {
  window.addEventListener('devicemotion', onDeviceMotion);
  crashDetectionActive = true; lastMagnitudes = [];
  const dot = document.getElementById('crashDot');
  const label = document.getElementById('crashLabel');
  const toggle = document.getElementById('crashToggle');
  if (dot) dot.className = 'crash-dot on';
  if (label) label.textContent = 'Active — monitoring impacts';
  if (toggle) toggle.classList.add('on');
  addBotMsg('Crash detection active. Sudden impact will trigger SOS with a 5-second cancel window.');
}

function disableCrashDetection() {
  window.removeEventListener('devicemotion', onDeviceMotion);
  crashDetectionActive = false; lastMagnitudes = [];
  const dot = document.getElementById('crashDot');
  const label = document.getElementById('crashLabel');
  const toggle = document.getElementById('crashToggle');
  if (dot) dot.className = 'crash-dot off';
  if (label) label.textContent = 'Inactive — enable on mobile';
  if (toggle) toggle.classList.remove('on');
}

function onDeviceMotion(e) {
  const acc = e.accelerationIncludingGravity;
  if (!acc) return;
  const mag = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);
  lastMagnitudes.push(mag);
  if (lastMagnitudes.length > CRASH_WINDOW) lastMagnitudes.shift();
  if (lastMagnitudes.length === CRASH_WINDOW && lastMagnitudes.every(m => m > CRASH_THRESHOLD)) {
    lastMagnitudes = [];
    triggerCrashAlert();
  }
}

function triggerCrashAlert() {
  if (document.getElementById('crashOverlay').classList.contains('active')) return;
  document.getElementById('crashOverlay').classList.add('active');
  crashCountdownSecs = 5;
  document.getElementById('crashCountdown').textContent = crashCountdownSecs;
  crashCountdownInterval = setInterval(() => {
    crashCountdownSecs--;
    document.getElementById('crashCountdown').textContent = crashCountdownSecs;
    if (crashCountdownSecs <= 0) {
      clearInterval(crashCountdownInterval);
      document.getElementById('crashOverlay').classList.remove('active');
      crashSOSnow();
    }
  }, 1000);
}

function cancelCrashSOS() {
  clearInterval(crashCountdownInterval);
  document.getElementById('crashOverlay').classList.remove('active');
  addBotMsg('SOS cancelled. Crash detection still active.');
}

function crashSOSnow() {
  clearInterval(crashCountdownInterval);
  document.getElementById('crashOverlay').classList.remove('active');
  autoAlertContacts();
  callSOS();
}

function autoAlertContacts() {
  const p = loadMedProfile();
  if (!p || !p.contactPhone || !locationReady) return;
  const mapsUrl = `https://www.google.com/maps?q=${userLat},${userLon}`;
  const msg = `RoadSoS Emergency Alert\n${p.name || 'Your contact'} may have been in a road accident.\nLocation: ${mapsUrl}\nAmbulance: 108 | Police: 100\n${getMedProfileText()}`;
  setTimeout(() => {
    window.open(`https://wa.me/${p.contactPhone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(msg)}`, '_blank');
  }, 1500);
}

// ═══════════════════════════════════════════════════════════════
//  LIVE INCIDENT FEED (SSE)
// ═══════════════════════════════════════════════════════════════
function startIncidentFeed() {
  if (_incidentSource || !window.EventSource) return;
  _incidentSource = new EventSource('/api/incident_stream');
  _incidentSource.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'ping' || !data.lat || !userLat) return;
      const dist = roughDist(userLat, userLon, data.lat, data.lon);
      if (dist <= 5) showIncidentAlert(data, dist);
    } catch (_) {}
  };
  _incidentSource.onerror = () => {
    _incidentSource?.close(); _incidentSource = null;
    setTimeout(startIncidentFeed, 15000);
  };
}

function roughDist(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  return R * 2 * Math.asin(Math.sqrt(
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  ));
}

function showIncidentAlert(data, dist) {
  const b = document.getElementById('incidentBanner');
  document.getElementById('incidentTitle').textContent =
    `${data.kind === 'accident' ? 'Accident' : 'Incident'} reported ${dist.toFixed(1)} km away`;
  document.getElementById('incidentSub').textContent =
    `${data.location || ''} · ${data.injuries !== 'None' ? data.injuries + ' injuries' : 'No injuries'} · ${data.time || ''}`;
  b.style.display = 'flex';
  setTimeout(() => { b.style.display = 'none'; }, 12000);
}

function closeIncidentAlert() {
  document.getElementById('incidentBanner').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
//  SEVERITY HELPERS
// ═══════════════════════════════════════════════════════════════
function calcSeverityScore(t) {
  let s = 1;
  if (t.injured) s += 3;
  if (t.unconscious) s += 4;
  if (t.fire) s += 3;
  if (t.breakdown && !t.injured) s = Math.min(s, 4);
  return Math.min(s, 10);
}

function severityLabel(score) {
  if (score <= 3) return { text: 'Minor',    cls: 'sev-minor' };
  if (score <= 6) return { text: 'Moderate', cls: 'sev-moderate' };
  if (score <= 8) return { text: 'Serious',  cls: 'sev-serious' };
  return               { text: 'CRITICAL',  cls: 'sev-critical' };
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 1 — LIVE HOME STATS
// ═══════════════════════════════════════════════════════════════
function loadHomeStats() {
  if (!userLat) return;
  const statsBar = document.getElementById('statsBar');
  if (statsBar) statsBar.style.display = 'flex';

  const pairs = [
    ['hospital',     'statHospitalNum'],
    ['police',       'statPoliceNum'],
    ['blood_bank',   'statBloodNum'],
    ['vehicle_repair','statMechanicNum'],
  ];

  pairs.forEach(([type, elId]) => {
    fetch(`/api/nearby/${type}?lat=${userLat}&lon=${userLon}&radius=10`)
      .then(r => r.json())
      .then(d => {
        const el = document.getElementById(elId);
        if (el) el.textContent = d.count || 0;
      })
      .catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 2 — POST-SOS EMERGENCY DASHBOARD
// ═══════════════════════════════════════════════════════════════
let _emgTimerInterval = null;

function showEmergencyDashboard(sosData) {
  const dash = document.getElementById('emergencyDashboard');
  if (!dash) return;
  dash.style.display = 'flex';

  // Start inline timer
  let secs = timerSecs;
  const timerEl = document.getElementById('emgTimerInline');
  _emgTimerInterval = setInterval(() => {
    secs--;
    if (timerEl) {
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
    }
    if (secs <= 0) clearInterval(_emgTimerInterval);
  }, 1000);

  // Populate nearest hospital
  const svcs = sosData.services || {};
  const hospitals = svcs.hospital || svcs.ambulance || [];
  const nearest = hospitals[0];
  if (nearest) {
    const nameEl = document.getElementById('emgHospitalName');
    const distEl = document.getElementById('emgHospitalDist');
    const callEl = document.getElementById('emgCallBtn');
    const navEl  = document.getElementById('emgNavBtn');
    if (nameEl) nameEl.textContent = nearest.name;
    if (distEl) distEl.textContent = `${nearest.distance_km} km away`;
    if (callEl && nearest.phone) callEl.href = `tel:${nearest.phone.replace(/\s/g,'')}`;
    if (navEl)  navEl.href = `https://www.google.com/maps/dir/?api=1&destination=${nearest.lat},${nearest.lon}`;
  }

  // Contact status
  const p = loadMedProfile();
  const contactEl = document.getElementById('emgContactStatus');
  const contactTxt = document.getElementById('emgContactText');
  if (p && p.contactName) {
    setTimeout(() => {
      if (contactEl) contactEl.classList.add('done');
      if (contactTxt) contactTxt.textContent = `${p.contactName} alerted via WhatsApp`;
    }, 1500);
  } else {
    if (contactTxt) contactTxt.textContent = 'No emergency contact set — add in Profile';
  }

  // Services found status
  const svcEl  = document.getElementById('emgServicesStatus');
  const svcTxt = document.getElementById('emgServicesText');
  const total  = Object.values(svcs).reduce((n, a) => n + (a||[]).length, 0);
  setTimeout(() => {
    if (svcEl)  svcEl.classList.add('done');
    if (svcTxt) svcTxt.textContent = `${total} services found nearby`;
  }, 2500);

  // Populate mini services list
  const list = document.getElementById('emgServicesList');
  if (list) {
    list.innerHTML = '';
    for (const [key, items] of Object.entries(svcs)) {
      if (!items || !items.length) continue;
      const item = items[0];
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
      list.innerHTML += `
        <div class="emg-svc-row">
          <div class="emg-svc-info">
            <div class="emg-svc-name">${esc(item.name)}</div>
            <div class="emg-svc-type">${esc(item.label || key)}</div>
          </div>
          <span class="emg-svc-dist">${item.distance_km} km</span>
          <a href="${mapsUrl}" target="_blank" class="emg-svc-nav">Go</a>
        </div>`;
    }
  }
}

function closeEmergencyDashboard() {
  clearInterval(_emgTimerInterval);
  const dash = document.getElementById('emergencyDashboard');
  if (dash) dash.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 3 — "I WITNESSED AN ACCIDENT"
// ═══════════════════════════════════════════════════════════════
function openWitnessFlow() {
  if (!locationReady) {
    requestLocation();
    addBotMsg('Getting your location first — then you can submit the report.');
    return;
  }
  document.getElementById('witnessOverlay').style.display = 'flex';
}

function closeWitnessFlow() {
  document.getElementById('witnessOverlay').style.display = 'none';
}

function handleWitnessBackdrop(e) {
  if (e.target === document.getElementById('witnessOverlay')) closeWitnessFlow();
}

function submitWitness() {
  const payload = {
    kind:     document.getElementById('wIncidentType').value,
    vehicles: document.getElementById('wVehicles').value,
    injuries: document.getElementById('wInjuries').value,
    details:  document.getElementById('wDetails').value.trim(),
    lat: userLat, lon: userLon,
    time: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    reporter: 'witness'
  };
  closeWitnessFlow();
  fetch('/api/report_incident', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
  // Show confirmation banner
  const b = document.getElementById('incidentBanner');
  document.getElementById('incidentTitle').textContent = 'Report submitted — thank you';
  document.getElementById('incidentSub').textContent = `${payload.kind} · ${payload.injuries} · alerting users nearby`;
  b.style.display = 'flex';
  setTimeout(() => { b.style.display = 'none'; }, 6000);
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 4 — DOCUMENT VAULT
// ═══════════════════════════════════════════════════════════════
function openDocModal() {
  const d = loadDocVault();
  if (d) {
    ['dvRC','dvInsurance','dvInsuranceExp','dvDL','dvVehicle','dvOwner'].forEach(id => {
      const el = document.getElementById(id);
      const key = id.replace('dv','').toLowerCase();
      const map = { rc:'rc', insurance:'insurance', insuranceexp:'insuranceExp', dl:'dl', vehicle:'vehicle', owner:'owner' };
      if (el && d[map[key]]) el.value = d[map[key]];
    });
  }
  document.getElementById('docModal').style.display = 'flex';
}

function closeDocModal() {
  document.getElementById('docModal').style.display = 'none';
}

function saveDocVault() {
  const d = {
    rc:           document.getElementById('dvRC').value.trim().toUpperCase(),
    insurance:    document.getElementById('dvInsurance').value.trim(),
    insuranceExp: document.getElementById('dvInsuranceExp').value,
    dl:           document.getElementById('dvDL').value.trim().toUpperCase(),
    vehicle:      document.getElementById('dvVehicle').value.trim(),
    owner:        document.getElementById('dvOwner').value.trim(),
  };
  localStorage.setItem('roadsos_doc_vault', JSON.stringify(d));
  closeDocModal();
  loadDocVaultDisplay();
}

function loadDocVault() {
  try { return JSON.parse(localStorage.getItem('roadsos_doc_vault') || 'null'); } catch { return null; }
}

function loadDocVaultDisplay() {
  const d = loadDocVault();
  const sub   = document.getElementById('docVaultSub');
  const badges = document.getElementById('docBadges');
  const shareBtn = document.getElementById('docShareBtn');
  if (!d) return;
  const filled = [d.rc, d.dl, d.vehicle].filter(Boolean);
  if (sub) sub.textContent = filled.length ? filled.join(' · ') : 'Tap to add documents';
  if (badges) {
    badges.innerHTML = '';
    if (d.rc)      badges.innerHTML += `<span class="doc-badge">RC: ${esc(d.rc)}</span>`;
    if (d.dl)      badges.innerHTML += `<span class="doc-badge">DL: ${esc(d.dl)}</span>`;
    if (d.vehicle) badges.innerHTML += `<span class="doc-badge">${esc(d.vehicle)}</span>`;
    if (d.insuranceExp) {
      const exp = new Date(d.insuranceExp);
      const expired = exp < new Date();
      badges.innerHTML += `<span class="doc-badge ${expired ? 'expired' : ''}">Ins: ${expired ? 'EXPIRED' : d.insuranceExp}</span>`;
    }
  }
  if (shareBtn && filled.length) shareBtn.style.display = 'flex';
}

function shareDocVault() {
  const d = loadDocVault();
  if (!d) return;
  const loc = locationReady ? `https://www.google.com/maps?q=${userLat},${userLon}` : 'Location not shared';
  const lines = [
    'RoadSoS — Vehicle Documents',
    d.owner    ? `Owner: ${d.owner}` : '',
    d.vehicle  ? `Vehicle: ${d.vehicle}` : '',
    d.rc       ? `RC: ${d.rc}` : '',
    d.dl       ? `DL: ${d.dl}` : '',
    d.insurance ? `Insurance: ${d.insurance}` : '',
    d.insuranceExp ? `Expiry: ${d.insuranceExp}` : '',
    `Location: ${loc}`,
  ].filter(Boolean);
  const msg = lines.join('\n');
  navigator.clipboard.writeText(msg).then(() => {
    const btn = document.getElementById('docShareBtn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share with police / insurance`; }, 2000); }
  });
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 5 — "I'M SAFE" PING
// ═══════════════════════════════════════════════════════════════
function imSafe() {
  stopTimer();
  closeEmergencyDashboard();
  const p = loadMedProfile();
  if (p && p.contactPhone && locationReady) {
    const mapsUrl = `https://www.google.com/maps?q=${userLat},${userLon}`;
    const msg = `RoadSoS — I'm Safe\n${p.name || 'Your contact'} is safe and accounted for.\nLocation: ${mapsUrl}`;
    window.open(`https://wa.me/${p.contactPhone.replace(/[^0-9]/g,'')}?text=${encodeURIComponent(msg)}`, '_blank');
  }
  // Show confirmation
  const b = document.getElementById('incidentBanner');
  document.getElementById('incidentTitle').textContent = "You're marked safe";
  document.getElementById('incidentSub').textContent = 'Emergency alert stopped · Contacts notified';
  b.style.display = 'flex';
  setTimeout(() => { b.style.display = 'none'; }, 5000);
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE 6 — BLOOD BANK TAB + BLOOD TYPE FILTER
// ═══════════════════════════════════════════════════════════════
let _bloodFilterType = null;
let _lastBloodResults = [];

function setBloodFilter(type, el) {
  _bloodFilterType = type;
  document.querySelectorAll('.bt-pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  renderBloodList(_lastBloodResults);
}

function renderBloodList(items) {
  _lastBloodResults = items;
  const list = document.getElementById('serviceList');
  let filtered = items;
  if (_bloodFilterType) {
    // Blood banks don't usually have type metadata from OSM — show all with note
    filtered = items; // show all; highlight type filter as a future enhancement
  }
  if (!filtered.length) {
    // Pre-fill from medical profile as a convenience
    const p = loadMedProfile();
    const typeHint = p && p.blood ? ` Your blood type: <strong>${p.blood}</strong>. ` : '';
    list.innerHTML = `<div class="empty-state"><p>No blood banks found in this area.${typeHint}<br>Try calling hospitals directly — most have blood banks on site.</p><a href="tel:104" class="btn-primary-sm">Call 104 — Blood Bank Helpline</a></div>`;
    return;
  }
  const p = loadMedProfile();
  const myType = p && p.blood ? p.blood : null;
  list.innerHTML = filtered.map(item => {
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}`;
    const phoneHtml = item.phone ? `<a href="tel:${item.phone.replace(/\s/g,'')}" class="svc-card-call">${esc(item.phone)}</a>` : '<span class="svc-card-call">Call to confirm availability</span>';
    const typeTag = myType ? `<span class="blood-type-tag">Your type: ${myType}</span>` : '';
    return `<div class="svc-card blood-bank-card">
      <div class="svc-card-info">
        <div class="svc-card-name">${esc(item.name)}</div>
        ${phoneHtml}
        ${typeTag}
      </div>
      <span class="svc-card-dist ${parseFloat(item.distance_km) > 15 ? 'far' : ''}">${item.distance_km} km</span>
      <a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-nav">Navigate</a>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
