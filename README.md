# RoadSoS — Emergency Road Assistance Platform
### Road Safety Hackathon 2026 | CoERS, IIT Madras | Problem Statement 1.3

---

## What it does

RoadSoS is a web-based conversational assistant that helps accident victims and bystanders instantly find the nearest emergency services — hospitals, ambulance stations, police stations, vehicle rescue, and pharmacies — along with country-specific emergency helpline numbers and first aid guidance.

## Quick Start

### Requirements
- Python 3.8+
- Internet connection (for live OSM data; offline mode available)

### Run (Windows)
```
Double-click run.bat
```

### Run (manual)
```bash
pip install -r requirements.txt
python app.py
```

Then open: **http://localhost:5000**

---

## How to use

1. Open the app in a browser
2. Click **Share Location** or allow location access when prompted
3. Either click **SOS** for immediate multi-service search, or type your situation
4. Service cards appear with distance, phone number, and a Navigate button
5. Emergency helpline numbers are always shown at the top

---

## Features

| Feature | Description |
|---------|-------------|
| SOS Button | One-tap triggers location + multi-service search |
| NLP Intent | Understands natural language ("car accident", "someone unconscious") |
| Live OSM Data | Real-time data from OpenStreetMap (global coverage) |
| Country Helplines | Auto-detects country, shows correct emergency numbers |
| Offline Mode | Last results cached in browser; helplines always available |
| First Aid Guide | Contextual steps for accident, fire, unconscious victim |
| Navigation | Direct Google Maps links from each service card |
| Mobile-Friendly | Responsive, no app install needed |

---

## Tech Stack

- **Backend**: Python 3.11, Flask 3.0
- **Data**: OpenStreetMap via Overpass API, Nominatim (geocoding)
- **Frontend**: HTML5, CSS3, Vanilla JS — no framework, loads on 2G
- **Distance**: Haversine formula for accurate great-circle distances

---

## File Structure

```
roadsos/
├── app.py                  # Flask backend, API routes, intent parser
├── requirements.txt        # Python dependencies
├── run.bat                 # Windows launcher
├── templates/
│   └── index.html          # Chat UI
├── static/
│   ├── css/style.css       # Dark-mode UI
│   └── js/main.js          # Frontend logic, chat, map
└── data/
    ├── emergency_numbers.json   # Country helpline database
    └── offline_cache.json       # Offline fallback sample
```
