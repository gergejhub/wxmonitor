/* Wizz AWC Monitor – UX v32.2 (PATCH)
   - TV mode: larger labels + affected-airports list ALWAYS fully visible (wrap/no truncation)
   - Airport Change History: render as a trend line chart + top movers table
*/

const $ = (sel) => document.querySelector(sel);

const UI = {
  tvToggle: $('#tvToggle'),
  airportSearch: $('#airportSearch'),
  datasetSelect: $('#datasetSelect'),
  reloadBtn: $('#reloadBtn'),
  tiles: $('#tiles'),
  lastUpdated: $('#lastUpdated'),
  airportSelect: $('#airportSelect'),
  topMoversTableBody: $('#topMoversTable tbody'),
  simulateBtn: $('#simulateBtn'),
  resetHistoryBtn: $('#resetHistoryBtn'),
  trendCanvas: $('#trendChart'),
};

const STORAGE_KEY = 'awc_change_history_v32_2';

let state = {
  alerts: [],
  airports: [],
  history: {},      // { ICAO: [{ts, type, severity}] }
  trendChart: null,
};

function nowIso() {
  return new Date().toISOString();
}

function fmtLocal(tsIso) {
  try {
    const d = new Date(tsIso);
    return d.toLocaleString(undefined, { hour12: false });
  } catch {
    return tsIso;
  }
}

function severityToBadge(sev) {
  if (sev === 'CRIT') return { cls: 'badge--crit', label: 'CRIT' };
  if (sev === 'WARN') return { cls: 'badge--warn', label: 'WARN' };
  return { cls: 'badge--ok', label: 'OK' };
}

function tileId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'');
}

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return res.json();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistory(history) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function ensureHistorySeed(airports) {
  const existing = loadHistory();
  const hasAny = Object.keys(existing || {}).length > 0;
  if (hasAny) return existing;

  const seeded = {};
  const now = Date.now();
  for (const ap of airports.slice(0, 25)) {
    const n = Math.floor(Math.random() * 10);
    const list = [];
    for (let i = 0; i < n; i++) {
      const t = new Date(
        now - Math.floor(Math.random() * 48) * 3600_000 - Math.floor(Math.random()*60)*60_000
      ).toISOString();
      list.push({ ts: t, type: 'alert_change', severity: ['OK','WARN','CRIT'][Math.floor(Math.random()*3)] });
    }
    seeded[ap.icao] = list.sort((a,b) => a.ts.localeCompare(b.ts));
  }
  saveHistory(seeded);
  return seeded;
}

function getAffectedAirportsForTile(tile) {
  const list = Array.isArray(tile.airports) ? tile.airports : [];
  const mapped = list.map(code => {
    const c = String(code).trim().toUpperCase();
    const a = state.airports.find(x => x.icao === c || x.iata === c);
    if (!a) return { label: c, key: c };
    return { label: a.iata || a.icao, key: a.icao };
  });

  const seen = new Set();
  const out = [];
  for (const x of mapped) {
    const k = `${x.key}|${x.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function renderTiles(filterText = '') {
  const f = String(filterText || '').trim().toUpperCase();

  const filtered = state.alerts.filter(tile => {
    if (!f) return true;
    const affected = getAffectedAirportsForTile(tile);
    return affected.some(a => a.label.includes(f) || a.key.includes(f));
  });

  UI.tiles.innerHTML = '';
  for (const tile of filtered) {
    const { cls, label } = severityToBadge(tile.severity);
    const affected = getAffectedAirportsForTile(tile);

    const el = document.createElement('div');
    el.className = 'tile';
    el.id = `tile-${tileId(tile.name)}`;

    const trigger = tile.trigger ? String(tile.trigger) : '—';
    const triggerHtml = trigger.includes('<mark>')
      ? trigger
      : `<code>${escapeHtml(trigger)}</code>`;

    el.innerHTML = `
      <div class="tile__top">
        <div>
          <div class="tile__name">${escapeHtml(tile.name || '—')}</div>
          <div class="tile__status">${escapeHtml(tile.status || '—')}</div>
        </div>
        <div class="badge ${cls}">${label}</div>
      </div>

      <div class="tile__body">
        <div class="tile__trigger">
          <div class="label">Trigger</div>
          <div class="value">${triggerHtml}</div>
        </div>

        <div class="tile__airports">
          <div class="label">Affected airports (IATA)</div>
          <div class="airportList">
            ${affected.map(a => `<span class="airportPill" title="${escapeHtml(a.key)}">${escapeHtml(a.label)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;

    UI.tiles.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setTvMode(isOn) {
  document.body.classList.toggle('tv', isOn);
  UI.tvToggle.textContent = `TV View: ${isOn ? 'ON' : 'OFF'}`;
  localStorage.setItem('awc_tv_mode', isOn ? '1' : '0');
}

function getTvMode() {
  return localStorage.getItem('awc_tv_mode') === '1';
}

function pushHistoryEvent(icao, severity='WARN', type='alert_change') {
  const key = String(icao).toUpperCase();
  state.history[key] = state.history[key] || [];
  state.history[key].push({ ts: nowIso(), type, severity });
  if (state.history[key].length > 500) state.history[key] = state.history[key].slice(-500);
  saveHistory(state.history);
}

function eventsLastHours(list, hours=24) {
  const cutoff = Date.now() - hours*3600_000;
  return (list || []).filter(e => Date.parse(e.ts) >= cutoff);
}

function buildTopMovers() {
  const rows = [];
  for (const ap of state.airports) {
    const list = state.history[ap.icao] || [];
    const last24 = eventsLastHours(list, 24);
    if (last24.length === 0) continue;

    const lastTs = last24[last24.length - 1]?.ts || null;
    rows.push({
      icao: ap.icao,
      iata: ap.iata || '',
      n: last24.length,
      last: lastTs
    });
  }
  rows.sort((a,b) => b.n - a.n);
  return rows.slice(0, 15);
}

function renderTopMoversTable() {
  const movers = buildTopMovers();
  UI.topMoversTableBody.innerHTML = movers.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.iata || r.icao)}</strong><div class="mutedSmall">${escapeHtml(r.icao)}</div></td>
      <td>${r.n}</td>
      <td>${r.last ? escapeHtml(fmtLocal(r.last)) : '—'}</td>
    </tr>
  `).join('') || `
    <tr><td colspan="3" class="mutedSmall">No history events found. Use “Simulate +1 event” or integrate your real change log.</td></tr>
  `;
}

function populateAirportSelect() {
  const set = new Set();
  for (const k of Object.keys(state.history)) set.add(k);

  for (const t of state.alerts) {
    (Array.isArray(t.airports) ? t.airports : []).forEach(c => {
      const code = String(c).trim().toUpperCase();
      const ap = state.airports.find(x => x.icao === code || x.iata === code);
      if (ap) set.add(ap.icao);
    });
  }

  const list = [...set].map(icao => state.airports.find(a => a.icao === icao)).filter(Boolean);
  if (list.length === 0) list.push(...state.airports.slice(0, 30));

  list.sort((a,b) => (a.iata || a.icao).localeCompare(b.iata || b.icao));

  UI.airportSelect.innerHTML = list.map(a => `<option value="${a.icao}">${escapeHtml(a.iata || a.icao)} (${escapeHtml(a.icao)})</option>`).join('');
}

function buildTrendSeries(icao) {
  const key = String(icao).toUpperCase();
  const list = state.history[key] || [];
  const hours = 48;
  const now = Date.now();
  const buckets = [];
  for (let i = hours; i >= 0; i--) {
    const start = now - i*3600_000;
    const end = start + 3600_000;
    const label = new Date(start).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const n = list.filter(e => {
      const t = Date.parse(e.ts);
      return t >= start && t < end;
    }).length;
    buckets.push({ label, n });
  }
  return buckets;
}

function renderTrendChart(icao) {
  const series = buildTrendSeries(icao);
  const labels = series.map(x => x.label);
  const data = series.map(x => x.n);

  if (state.trendChart) {
    state.trendChart.data.labels = labels;
    state.trendChart.data.datasets[0].data = data;
    state.trendChart.update();
    return;
  }

  state.trendChart = new Chart(UI.trendCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Events per hour (last 48h)',
        data,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { maxTicksLimit: 8, color: 'rgba(233,236,245,.75)' },
          grid: { color: 'rgba(255,255,255,.07)' }
        },
        y: {
          beginAtZero: true,
          ticks: { precision: 0, color: 'rgba(233,236,245,.75)' },
          grid: { color: 'rgba(255,255,255,.07)' }
        }
      },
      plugins: {
        legend: { labels: { color: 'rgba(233,236,245,.85)' } },
        tooltip: { enabled: true }
      }
    }
  });
}

async function reloadAll() {
  try {
    UI.reloadBtn.disabled = true;

    const datasetUrl = UI.datasetSelect.value;
    const data = await loadJson(datasetUrl);

    state.airports = data.airports || [];
    state.alerts = data.tiles || [];

    state.history = ensureHistorySeed(state.airports);

    UI.lastUpdated.textContent = `Last updated: ${fmtLocal(data.generatedAt || nowIso())}`;

    renderTiles(UI.airportSearch.value);
    populateAirportSelect();
    renderTopMoversTable();

    const selected = UI.airportSelect.value || state.airports[0]?.icao;
    if (selected) renderTrendChart(selected);

  } catch (err) {
    console.error(err);
    UI.lastUpdated.textContent = `Last updated: ERROR (${err?.message || err})`;
    UI.tiles.innerHTML = `<div class="hint">Data load error: ${escapeHtml(err?.message || String(err))}</div>`;
  } finally {
    UI.reloadBtn.disabled = false;
  }
}

function wireEvents() {
  UI.tvToggle.addEventListener('click', () => {
    setTvMode(!document.body.classList.contains('tv'));
  });

  UI.airportSearch.addEventListener('input', () => {
    renderTiles(UI.airportSearch.value);
  });

  UI.reloadBtn.addEventListener('click', reloadAll);

  UI.airportSelect.addEventListener('change', () => {
    renderTrendChart(UI.airportSelect.value);
  });

  UI.simulateBtn.addEventListener('click', () => {
    const ap = state.airports[Math.floor(Math.random() * state.airports.length)];
    if (!ap) return;
    pushHistoryEvent(ap.icao, ['OK','WARN','CRIT'][Math.floor(Math.random()*3)]);
    renderTopMoversTable();
    renderTrendChart(UI.airportSelect.value || ap.icao);
  });

  UI.resetHistoryBtn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    state.history = ensureHistorySeed(state.airports);
    renderTopMoversTable();
    renderTrendChart(UI.airportSelect.value || state.airports[0]?.icao);
  });
}

(function init() {
  setTvMode(getTvMode());
  wireEvents();
  reloadAll();
})();
