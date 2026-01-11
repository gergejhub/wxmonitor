# Wizz AWC Monitor – UX v32.2 (TV Tiles + Stat Trends) – PATCH

This ZIP is a **drop-in static bundle** intended for GitHub Pages / any static web host.

## What this patch implements

1. **TV View tiles**
   - Larger labels and trigger text for distance readability.
   - The affected-airport list shows **all** impacted airports and **wraps** (no truncation).
   - Airports are displayed as **IATA** codes when available (fallback: ICAO).

2. **Airport Change History – trend visualization**
   - Line chart: events/hour for the selected airport (last 48h).
   - Table: top airports by number of change events (last 24h).
   - Uses `localStorage` (key: `awc_change_history_v32_2`) to emulate a change-log pipeline.

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Integrate with your real system

Replace `data/sample_alerts.json` with your generated JSON.

Required schema:

```json
{
  "generatedAt": "ISO timestamp",
  "airports": [{"icao":"LHBP","iata":"BUD","name":"Budapest"}],
  "tiles": [{"name":"ICE","severity":"WARN","status":"...","trigger":"...","airports":["LHBP","EGGW"]}]
}
```

Change history schema (same localStorage key):

```json
{ "LHBP": [{"ts":"ISO","type":"alert_change","severity":"WARN"}] }
```

Charting uses Chart.js from a CDN. If CDNs are blocked, vendor it locally and update `index.html`.
