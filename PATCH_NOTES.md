# PATCH_NOTES (UX v32.2)

If you are applying this as a patch over an existing codebase:

## TV Tiles – key deltas

- Ensure the affected airports list does **not** truncate:
  - Use `flex-wrap: wrap` on the airport list container.
  - Remove any `max-height`, `overflow: hidden`, or `text-overflow: ellipsis`.

- Increase tile label sizes in TV mode:
  - Add a `body.tv` class and upsize `.tile__name`, `.tile__trigger`, `.airportPill`.

## Airport Change History – trend view

- Store per-airport change events:
  - `history[ICAO] = [{ts, type, severity}, ...]`

- Render:
  - Line chart per airport: bucket to hourly intervals (48h window).
  - “Top movers” table: count events last 24h.

Reference implementation is in `assets/app.js` and `assets/styles.css`.
