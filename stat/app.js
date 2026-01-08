
/* v30 stats
   - polls ../data/latest.json every 60s (CDN)
   - maintains local history in localStorage for visual verification
*/
const $ = (id)=>document.getElementById(id);

const KEY = "wxmonitor_stats_history_v1";
const MAX = 240; // keep ~4 hours at 1-min polling
const EXPECTED_MIN_DEFAULT = 10;

function fmtUTC(d){
  return d.toISOString().replace("T"," ").slice(0,16) + "Z";
}
function mins(n){ return `${Math.max(0, Math.round(n))}m`; }

function parseTimeGroupFromRaw(raw){
  // METAR/TAF group: DDHHMMZ
  const m = /\s(\d{2})(\d{2})(\d{2})Z\b/.exec(raw||"");
  if (!m) return null;
  return {dd:+m[1], hh:+m[2], mm:+m[3]};
}
function approxIssueDateNowUTC(tg){
  // Return a Date in UTC, choosing month rollover safely.
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  // candidate in current month
  let d = new Date(Date.UTC(y, mo, tg.dd, tg.hh, tg.mm, 0));
  // If too far in future (day rollover), shift back a month; if too far in past, shift forward.
  const diffMin = (now - d) / 60000;
  if (diffMin < -720) { // >12h in future
    d = new Date(Date.UTC(y, mo-1, tg.dd, tg.hh, tg.mm, 0));
  } else if (diffMin > 43200) { // >30d in past
    d = new Date(Date.UTC(y, mo+1, tg.dd, tg.hh, tg.mm, 0));
  }
  return d;
}
function ageFromRaw(raw){
  const tg = parseTimeGroupFromRaw(raw);
  if (!tg) return null;
  const t = approxIssueDateNowUTC(tg);
  return (Date.now() - t.getTime())/60000;
}

function normStation(s){
  const icao = (s.icao || s.station || "").toUpperCase();
  const iata = (s.iata || "").toUpperCase();
  const metarRaw = s.metarRaw || s.metar || "";
  const tafRaw = s.tafRaw || s.taf || "";
  let metAge = (s.metarAgeMin ?? s.metarAge ?? null);
  let tafAge = (s.tafAgeMin ?? s.tafAge ?? null);
  if (metAge == null) metAge = ageFromRaw(metarRaw);
  if (tafAge == null) tafAge = ageFromRaw(tafRaw);
  return {icao,iata,metarRaw,tafRaw,metAge,tafAge};
}

function hasWx(raw, token){
  return new RegExp(`(^|\\s)${token}(\\s|$)`).test(raw||"");
}
function findVisMetersFromMetar(raw){
  // Priority: explicit 4-digit vis token (e.g. 0100), else "CAVOK" => 10000, else "9999"
  if (!raw) return null;
  if (/\bCAVOK\b/.test(raw)) return 10000;
  const m = /\b(\d{4})\b/.exec(raw);
  if (m) {
    const v = parseInt(m[1],10);
    // Protect against time groups like 0818/0918 by excluding tokens adjacent to '/'
    const idx = m.index;
    const before = raw[idx-1] || "";
    const after = raw[idx+m[1].length] || "";
    if (before === "/" || after === "/") return null;
    return v;
  }
  if (/\b9999\b/.test(raw)) return 10000;
  return null;
}
function metarTriggers(st){
  const r = st.metarRaw || "";
  const vis = findVisMetersFromMetar(r);
  const fg = hasWx(r,"FG") || hasWx(r,"BCFG") || hasWx(r,"MIFG") || hasWx(r,"PRFG");
  const fzfg = hasWx(r,"FZFG");
  const ts = /(^|\s)TS/.test(r);
  const sn = /(^|\s)-?SN/.test(r) || /SHSN/.test(r);
  const engIce = (vis!=null && vis<=150 && fzfg);
  const vis175 = (vis!=null && vis<=175);
  const crit = engIce || vis175 || ts;
  return {vis, fg, fzfg, ts, sn, engIce, vis175, crit};
}
function tafTriggers(st){
  const r = st.tafRaw || "";
  // Visibility in TAF can appear as 4 digits, but exclude time groups like 0818/0918
  let vis = null;
  const visMatch = [...(r.matchAll(/\b(\d{4})\b/g))].find(m=>{
    const idx=m.index;
    const before = r[idx-1] || "";
    const after = r[idx+m[1].length] || "";
    if (before === "/" || after === "/") return false;
    const v = parseInt(m[1],10);
    // Heuristic: accept only <= 9999
    return v<=9999;
  });
  if (visMatch) vis = parseInt(visMatch[1],10);
  const fg = hasWx(r,"FG") || hasWx(r,"BCFG") || hasWx(r,"MIFG") || hasWx(r,"PRFG");
  const fzfg = hasWx(r,"FZFG");
  const ts = /(^|\s)TS/.test(r);
  const sn = /(^|\s)-?SN/.test(r) || /SHSN/.test(r);
  const engIce = (vis!=null && vis<=150 && fzfg);
  const vis175 = (vis!=null && vis<=175);
  const crit = engIce || vis175 || ts;
  return {vis, fg, fzfg, ts, sn, engIce, vis175, crit};
}

function computeCounts(stations){
  let met=0, taf=0, eng=0, crit=0, vis175=0, ts=0;
  for (const st of stations){
    if (st.metarRaw) met++;
    if (st.tafRaw) taf++;
    const m = metarTriggers(st);
    const t = tafTriggers(st);
    if (m.engIce || t.engIce) eng++;
    if (m.vis175 || t.vis175) vis175++;
    if (m.ts || t.ts) ts++;
    // CRIT definition: match dashboard intent: METAR crit weighs more, but count either
    if (m.crit || t.crit) crit++;
  }
  return {met, taf, eng, crit, vis175, ts};
}

function loadHistory(){
  try{
    const x = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(x) ? x : [];
  }catch{ return []; }
}
function saveHistory(arr){
  localStorage.setItem(KEY, JSON.stringify(arr.slice(-MAX)));
}

let history = loadHistory();

let chUpdates=null, chCounts=null, chMissing=null;

function renderCharts(){
  const labels = history.map(h=> new Date(h.fetchedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
  const isNew = history.map(h=> h.isNew ? 1 : 0);
  const intervals = history.map(h=> h.deltaMin ?? null);

  const ctxU = document.getElementById("chUpdates").getContext("2d");
  if (chUpdates) chUpdates.destroy();
  chUpdates = new Chart(ctxU, {
    type:"line",
    data:{
      labels,
      datasets:[
        {label:"Δ (min) since previous generatedAt", data: intervals, tension:0.25},
        {label:"New data (1=yes)", data: isNew, yAxisID:"y1", tension:0.25}
      ]
    },
    options:{
      responsive:true,
      scales:{
        y:{beginAtZero:true, title:{display:true, text:"Minutes"}},
        y1:{beginAtZero:true, position:"right", ticks:{stepSize:1, max:1}, grid:{drawOnChartArea:false}}
      },
      plugins:{legend:{display:true}}
    }
  });

  const ctxC = document.getElementById("chCounts").getContext("2d");
  if (chCounts) chCounts.destroy();
  chCounts = new Chart(ctxC, {
    type:"line",
    data:{
      labels,
      datasets:[
        {label:"ENG ICE OPS", data: history.map(h=>h.eng), tension:0.25},
        {label:"CRIT", data: history.map(h=>h.crit), tension:0.25},
        {label:"VIS≤175", data: history.map(h=>h.vis175), tension:0.25},
        {label:"TS", data: history.map(h=>h.ts), tension:0.25},
      ]
    },
    options:{responsive:true, plugins:{legend:{display:true}}, scales:{y:{beginAtZero:true}}}
  });

  const ctxM = document.getElementById("chMissing").getContext("2d");
  if (chMissing) chMissing.destroy();
  chMissing = new Chart(ctxM, {
    type:"line",
    data:{
      labels,
      datasets:[
        {label:"Stations", data: history.map(h=>h.stations), tension:0.25},
        {label:"METAR present", data: history.map(h=>h.met), tension:0.25},
        {label:"TAF present", data: history.map(h=>h.taf), tension:0.25},
      ]
    },
    options:{responsive:true, plugins:{legend:{display:true}}, scales:{y:{beginAtZero:true}}}
  });
}

function renderLog(){
  const tb = $("logBody");
  tb.innerHTML = "";
  const rows = history.slice(-40).reverse();
  for (const h of rows){
    const tr = document.createElement("tr");
    const cells = [
      new Date(h.fetchedAt).toLocaleString(),
      h.generatedAt ? fmtUTC(new Date(h.generatedAt)) : "—",
      h.deltaMin==null ? "—" : mins(h.deltaMin),
      h.isNew ? "YES" : "no",
      h.stations,
      h.met,
      h.taf,
      h.eng,
      h.crit,
      h.vis175,
      h.ts
    ];
    for (const c of cells){
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  $("storageNote").textContent = `Stored locally in this browser: ${history.length} points (max ${MAX}).`;
}

function computeIntervalsFromHistory(){
  const gens = history.filter(h=>h.generatedAt).map(h=>new Date(h.generatedAt).getTime());
  // use unique generatedAt times, compute deltas between unique points
  const uniq = [...new Set(gens)].sort((a,b)=>a-b);
  const deltas = [];
  for (let i=1;i<uniq.length;i++){
    deltas.push((uniq[i]-uniq[i-1])/60000);
  }
  if (!deltas.length) return null;
  const avg = deltas.reduce((a,b)=>a+b,0)/deltas.length;
  const last = deltas[deltas.length-1];
  return {avg, last, n:deltas.length};
}

function setExpected(min){
  $("expectedPill").textContent = `Expected: ${min} min`;
}

async function pullOnce(){
  const fetchedAt = Date.now();
  let data;
  try{
    const res = await fetch("../data/latest.json?cb="+Date.now(), {cache:"no-store"});
    if (!res.ok) throw new Error("HTTP "+res.status);
    data = await res.json();
  }catch(err){
    $("verdict").textContent = "ERROR";
    $("verdictSub").textContent = String(err);
    return;
  }

  const genAt = data.generatedAt || null;
  const genDate = genAt ? new Date(genAt) : null;
  $("genAt").textContent = genDate && !isNaN(genDate.getTime()) ? fmtUTC(genDate) : "—";
  const ageMin = genDate && !isNaN(genDate.getTime()) ? (Date.now()-genDate.getTime())/60000 : null;
  $("genAge").textContent = ageMin==null ? "—" : `Age: ${mins(ageMin)}`;

  const rawStations = Array.isArray(data.stations) ? data.stations : [];
  const stations = rawStations.map(normStation).filter(s=>s.icao && s.icao.length===4);
  const counts = computeCounts(stations);
  const missMet = stations.length - counts.met;
  const missTaf = stations.length - counts.taf;
  $("counts").textContent = `${stations.length} / ${missMet} METAR missing / ${missTaf} TAF missing`;
  $("countsSub").textContent = `METAR present: ${counts.met}, TAF present: ${counts.taf}`;

  const prev = history.length ? history[history.length-1] : null;
  const prevGen = prev?.generatedAt ? new Date(prev.generatedAt).getTime() : null;
  const currGen = genDate && !isNaN(genDate.getTime()) ? genDate.getTime() : null;
  const isNew = (prevGen!=null && currGen!=null) ? (currGen !== prevGen) : true;
  const deltaMin = (prevGen!=null && currGen!=null && isNew) ? ((currGen - prevGen)/60000) : null;

  history.push({
    fetchedAt,
    generatedAt: genAt,
    isNew,
    deltaMin,
    stations: stations.length,
    ...counts
  });
  history = history.slice(-MAX);
  saveHistory(history);

  // verdict
  const ints = computeIntervalsFromHistory();
  if (ints){
    $("avgInt").textContent = `${ints.avg.toFixed(1)} min`;
    $("avgIntSub").textContent = `Based on last ${ints.n} generatedAt changes. Last: ${ints.last.toFixed(1)} min`;
  }else{
    $("avgInt").textContent = "—";
    $("avgIntSub").textContent = "Need at least 2 distinct updates.";
  }

  // Simple health logic: new data within 2*expected OR age < 2*expected
  const expected = EXPECTED_MIN_DEFAULT;
  setExpected(expected);
  const ok = (ageMin!=null && ageMin <= expected*2);
  $("verdict").textContent = ok ? "OK" : "STALE";
  $("verdictSub").textContent = ok
    ? (isNew ? "New data detected on last poll." : "Data unchanged (no new generatedAt yet).")
    : `Last data is older than ${expected*2} minutes. Check Actions schedule/logs.`;

  renderLog();
  renderCharts();
}

function start(){
  $("btnNow").addEventListener("click", pullOnce);
  pullOnce();
  setInterval(pullOnce, 60*1000);
}
start();
