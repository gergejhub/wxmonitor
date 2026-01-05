# Wizz Air METAR/TAF Watch (GitHub Pages)

This repository hosts a static dashboard (GitHub Pages) that monitors METAR + TAF for a list of airports stored in `airports.txt` (ICAO codes, one per line).

Because browsers cannot reliably call `aviationweather.gov/api/*` from GitHub Pages due to missing CORS headers, the repository uses **GitHub Actions** to fetch METAR/TAF server-side every 10 minutes and commit the results to `data/latest.json`.

## Setup (10 minutes)

1. Put your Wizz airports in `airports.txt` (ICAO codes, one per line).
2. Enable **GitHub Pages**: Settings → Pages → Deploy from Branch → `main` / root.
3. Enable workflow write permissions:
   - Settings → Actions → General → Workflow permissions → **Read and write permissions**
   - Also enable “Allow GitHub Actions to create and approve pull requests” if your org policy requires it.
4. Check Actions tab: the workflow **Update METAR/TAF** should run on schedule (every 10 minutes) and on manual dispatch.

## Files

- `index.html` + `assets/*`: the web UI
- `.github/workflows/update-aviationweather.yml`: scheduled job
- `scripts/update-data.mjs`: Node script that:
  - reads `airports.txt`
  - builds ICAO→IATA mapping from OurAirports `airports.csv`
  - fetches METAR/TAF raw text from AviationWeather.gov
  - computes a severity score and highlights hazards
  - writes `data/latest.json`

## Notes

- This dashboard is for situational awareness only. Always use official briefing/dispatch sources for operational decisions.
