/* Front-end: renders data/latest.json created by GitHub Actions */
const DATA_URL = 'data/latest.json';
const AIRPORTS_URL = 'airports.txt';

const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s){
  return (s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function severityClass(score){
  if (score >= 70) return ['CRITICAL','b-crit'];
  if (score >= 45) return ['HIGH','b-high'];
  if (score >= 20) return ['MED','b-med'];
  return ['OK','b-ok'];
}

function fmtVis(m){
  if (m == null) return '—';
  if (m >= 10000) return '≥ 10 km';
  if (m >= 1000) return `${(m/1000).toFixed(1)} km`;
  return `${m} m`;
}

function renderRow(item, idx){
  const [label, cls] = severityClass(item.severityScore ?? 0);

  const airport = `${escapeHtml(item.icao)}${item.iata ? ' / ' + escapeHtml(item.iata) : ''}`;
  const vis = fmtVis(item.worst_visibility_m ?? item.visibility_m);

  const hazards = (item.hazards && item.hazards.length)
    ? item.hazards.map(h => `<span class="pill">${escapeHtml(h)}</span>`).join(' ')
    : '<span class="muted">—</span>';

  return `
    <tr>
      <td class="mono">${idx+1}</td>
      <td>
        <div style="font-weight:800">${airport}</div>
        <div class="kv">
          <span class="mono">${escapeHtml(item.name ?? '')}</span>
          ${item.updatedAt ? `<span class="mono">METAR time: ${escapeHtml(item.updatedAt)}</span>` : ''}
        </div>
      </td>
      <td><span class="badge ${cls}">${label} (${Math.round(item.severityScore ?? 0)})</span></td>
      <td class="mono">${escapeHtml(vis)}</td>
      <td>${hazards}</td>
      <td><div class="raw">${item.metarHtml ?? '<span class="muted">No METAR</span>'}</div></td>
      <td><div class="raw">${item.tafHtml ?? '<span class="muted">No TAF</span>'}</div></td>
    </tr>
  `;
}

async function load(){
  const tbody = $('#tbody');
  try{
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, {cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    $('#lastUpdate').textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—';

    const rows = (data.stations ?? []).map(renderRow).join('');
    tbody.innerHTML = rows || '<tr><td colspan="7" class="muted">No data.</td></tr>';
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Data load error: ${escapeHtml(String(e))}</td></tr>`;
  }
}

async function loadAirportsTxt(){
  try{
    const res = await fetch(`${AIRPORTS_URL}?t=${Date.now()}`, {cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    $('#airportList').textContent = txt.trim() || '(empty)';
  }catch(e){
    $('#airportList').textContent = `Could not load airports.txt: ${String(e)}`;
  }
}

let timer = null;
function startTimer(){
  stopTimer();
  timer = setInterval(load, REFRESH_MS);
}
function stopTimer(){
  if(timer) clearInterval(timer);
  timer = null;
}

$('#refreshBtn').addEventListener('click', () => load());
$('#autoRefresh').addEventListener('change', (e) => {
  if(e.target.checked) startTimer();
  else stopTimer();
});

loadAirportsTxt();
load();
startTimer();
