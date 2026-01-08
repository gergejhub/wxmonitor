
/* v30 stats
   - polls ../data/latest.json every 60s (CDN)
   - maintains local history in localStorage for visual verification
*/
const $ = (id)=>document.getElementById(id);

const KEY = "wxmonitor_stats_history_v1";
const KEY_SNAP = "wxmonitor_station_snap_v1";
const KEY_EVENTS = "wxmonitor_station_events_v1";
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

function extractRvrMin(raw){
  // e.g. R17/0400N or R35/0300N. Return minimum numeric RVR in meters, if any.
  if (!raw) return null;
  let min = null;
  const re = /R\d{2}[A-Z]?\/(\d{4})(?:[NMP])?/g;
  for (const m of raw.matchAll(re)){
    const v = parseInt(m[1],10);
    if (!isFinite(v)) continue;
    if (min==null || v < min) min = v;
  }
  return min;
}

function gustMaxKt(raw){
  // Max gust in KT from groups like 27015G30KT or VRB05G25KT
  if (!raw) return null;
  let max = null;
  for (const m of raw.matchAll(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g)){
    const g = parseInt(m[1],10);
    if (!isFinite(g)) continue;
    if (max==null || g > max) max = g;
  }
  return max;
}

function worstVisFromTaf(raw){
  // TAF may contain multiple vis groups (4 digits). Exclude time groups like 0818/0918.
  if (!raw) return null;
  let min = null;
  for (const m of raw.matchAll(/(\d{4})/g)){
    const idx = m.index;
    const before = raw[idx-1] || "";
    const after = raw[idx+m[1].length] || "";
    if (before === "/" || after === "/") continue; // time group
    const v0 = parseInt(m[1],10);
    if (!isFinite(v0)) continue;
    const v = (v0===9999) ? 10000 : v0;
    if (min==null || v < min) min = v;
  }
  return min;
}

function wxFlags(raw){
  const r = raw || "";
  const out = [];
  const add = (t)=>{ if (!out.includes(t)) out.push(t); };
  if (/(^|\s)TS/.test(r)) add("TS");
  if (hasWx(r,"FZFG")) add("FZFG");
  if (hasWx(r,"FG") || hasWx(r,"BCFG") || hasWx(r,"MIFG") || hasWx(r,"PRFG")) add("FG");
  if (/(^|\s)-?SN/.test(r) || /SHSN/.test(r)) add("SN");
  if (/(^|\s)-?RA/.test(r) || /SHRA/.test(r) || /(^|\s)-?DZ/.test(r) || /FZRA/.test(r)) add("RA/DZ");
  return out;
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


function loadObj(key, fallback){
  try{
    const x = JSON.parse(localStorage.getItem(key) || "null");
    if (x && typeof x === "object") return x;
  }catch{}
  return fallback;
}
function saveObj(key, obj){
  localStorage.setItem(key, JSON.stringify(obj));
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
let stationSnap = loadObj(KEY_SNAP, {});
let stationEvents = loadObj(KEY_EVENTS, {});
let latestStations = [];
let selectedIcao = null;


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


function pushStationEvent(icao, ev){
  const key = icao.toUpperCase();
  if (!stationEvents[key]) stationEvents[key] = [];
  stationEvents[key].push(ev);
  stationEvents[key] = stationEvents[key].slice(-30);
}

function fmtEv(ev){
  const when = fmtUTC(new Date(ev.t));
  const src = ev.src ? ` [${ev.src}]` : "";
  const dir = ev.dir ? ` (${ev.dir})` : "";
  const fromTo = (ev.from!=null || ev.to!=null) ? `: ${ev.from ?? "—"} → ${ev.to ?? "—"}` : "";
  return {when, what: `${ev.metric}${src}${dir}`, sub: ev.note || fromTo};
}

function updateStationHistory(stations, generatedAtIso){
  // Run only when data.generatedAt changed.
  const t = new Date(generatedAtIso).getTime();
  for (const st of stations){
    const icao = st.icao;
    const prev = stationSnap[icao] || {};
    const metVis = findVisMetersFromMetar(st.metarRaw);
    const metRvr = extractRvrMin(st.metarRaw);
    const metGust = gustMaxKt(st.metarRaw);
    const tafVis = worstVisFromTaf(st.tafRaw);
    const tafRvr = extractRvrMin(st.tafRaw);
    const tafGust = gustMaxKt(st.tafRaw);
    const metWx = wxFlags(st.metarRaw).join(",");
    const tafWx = wxFlags(st.tafRaw).join(",");

    // Changes are recorded only when METAR/TAF text changes (proxy: issue group or value changes).
    const metIssue = parseTimeGroupFromRaw(st.metarRaw);
    const tafIssue = parseTimeGroupFromRaw(st.tafRaw);

    // METAR VIS / RVR changes (priority: these are "current")
    if (metIssue && prev.metIssue && (metIssue.dd!==prev.metIssue.dd || metIssue.hh!==prev.metIssue.hh || metIssue.mm!==prev.metIssue.mm)){
      if (prev.metVis!=null && metVis!=null && prev.metVis !== metVis){
        pushStationEvent(icao, {
          t, metric:"METAR VIS", src:"METAR",
          dir: (metVis < prev.metVis) ? "worsened" : "improved",
          from: `${prev.metVis} m`, to: `${metVis} m`
        });
      }
      if (prev.metRvr!=null && metRvr!=null && prev.metRvr !== metRvr){
        pushStationEvent(icao, {
          t, metric:"METAR RVR(min)", src:"METAR",
          dir: (metRvr < prev.metRvr) ? "worsened" : "improved",
          from: `${prev.metRvr} m`, to: `${metRvr} m`
        });
      }

if (prev.metGust!=null && metGust!=null && prev.metGust !== metGust){
  pushStationEvent(icao, {
    t, metric:"METAR GUST(max)", src:"METAR",
    dir: (metGust > prev.metGust) ? "worsened" : "improved",
    from: `${prev.metGust} kt`, to: `${metGust} kt`
  });
}
      if (prev.metWx != null && metWx !== prev.metWx){
        pushStationEvent(icao, {t, metric:"METAR Wx", src:"METAR", note:`${prev.metWx||"—"} → ${metWx||"—"}`});
      }
    } else if (!prev.metIssue && metIssue){
      // first time
      if (metVis!=null) pushStationEvent(icao, {t, metric:"METAR VIS", src:"METAR", note:`initial: ${metVis} m`});
      if (metRvr!=null) pushStationEvent(icao, {t, metric:"METAR RVR(min)", src:"METAR", note:`initial: ${metRvr} m`});
      if (metWx) pushStationEvent(icao, {t, metric:"METAR Wx", src:"METAR", note:`initial: ${metWx}`});
    }

    // TAF changes (forecast "future")
    if (tafIssue && prev.tafIssue && (tafIssue.dd!==prev.tafIssue.dd || tafIssue.hh!==prev.tafIssue.hh || tafIssue.mm!==prev.tafIssue.mm)){
      if (prev.tafVis!=null && tafVis!=null && prev.tafVis !== tafVis){
        pushStationEvent(icao, {
          t, metric:"TAF worst VIS", src:"TAF",
          dir: (tafVis < prev.tafVis) ? "worsened" : "improved",
          from: `${prev.tafVis} m`, to: `${tafVis} m`
        });
      }
      if (prev.tafRvr!=null && tafRvr!=null && prev.tafRvr !== tafRvr){
        pushStationEvent(icao, {
          t, metric:"TAF RVR(min)", src:"TAF",
          dir: (tafRvr < prev.tafRvr) ? "worsened" : "improved",
          from: `${prev.tafRvr} m`, to: `${tafRvr} m`
        });
      }

if (prev.tafGust!=null && tafGust!=null && prev.tafGust !== tafGust){
  pushStationEvent(icao, {
    t, metric:"TAF GUST(max)", src:"TAF",
    dir: (tafGust > prev.tafGust) ? "worsened" : "improved",
    from: `${prev.tafGust} kt`, to: `${tafGust} kt`
  });
}
      if (prev.tafWx != null && tafWx !== prev.tafWx){
        pushStationEvent(icao, {t, metric:"TAF Wx", src:"TAF", note:`${prev.tafWx||"—"} → ${tafWx||"—"}`});
      }
    } else if (!prev.tafIssue && tafIssue){
      if (tafVis!=null) pushStationEvent(icao, {t, metric:"TAF worst VIS", src:"TAF", note:`initial: ${tafVis} m`});
      if (tafRvr!=null) pushStationEvent(icao, {t, metric:"TAF RVR(min)", src:"TAF", note:`initial: ${tafRvr} m`});
      if (tafWx) pushStationEvent(icao, {t, metric:"TAF Wx", src:"TAF", note:`initial: ${tafWx}`});
    }

    stationSnap[icao] = {
      metIssue: metIssue || prev.metIssue || null,
      tafIssue: tafIssue || prev.tafIssue || null,
      metVis, metRvr, metGust, tafVis, tafRvr, tafGust, metWx, tafWx,
      iata: st.iata || prev.iata || ""
    };
  }

  // Persist (size-capped per station by pushStationEvent)
  // Also cap total stations to keep localStorage healthy.
  const icaos = Object.keys(stationEvents);
  if (icaos.length > 250){
    // keep only the most recently active 200
    icaos.sort((a,b)=>{
      const ea = stationEvents[a]?.at(-1)?.t || 0;
      const eb = stationEvents[b]?.at(-1)?.t || 0;
      return eb - ea;
    });
    for (const k of icaos.slice(200)){
      delete stationEvents[k];
      delete stationSnap[k];
    }
  }
  saveObj(KEY_EVENTS, stationEvents);
  saveObj(KEY_SNAP, stationSnap);
}

function lastTimesFor(icao){
  const evs = stationEvents[icao] || [];
  let lastCh=0, lastDet=0, lastImp=0;
  for (const ev of evs){
    lastCh = Math.max(lastCh, ev.t || 0);
    if (ev.dir === "worsened") lastDet = Math.max(lastDet, ev.t || 0);
    if (ev.dir === "improved") lastImp = Math.max(lastImp, ev.t || 0);
  }
  return {
    lastCh: lastCh||null,
    lastDet: lastDet||null,
    lastImp: lastImp||null
  };
}

function pill(txt, kind){
  const cls = kind === "bad" ? "wxPill wxPill--bad" : "wxPill wxPill--ok";
  return `<span class="${cls}">${txt}</span>`;
}

function renderStations(){
  const tb = $("stBody");
  if (!tb) return;
  const q = ($("stSearch")?.value || "").trim().toUpperCase();
  const sort = ($("stSort")?.value || "det");
  const rows = latestStations.slice().filter(st=>{
    if (!q) return true;
    return (st.icao||"").includes(q) || (st.iata||"").includes(q);
  }).map(st=>{
    const icao = st.icao;
    const metVis = findVisMetersFromMetar(st.metarRaw);
    const metRvr = extractRvrMin(st.metarRaw);
    const metGust = gustMaxKt(st.metarRaw);
    const tafVis = worstVisFromTaf(st.tafRaw);
    const tafRvr = extractRvrMin(st.tafRaw);
    const tafGust = gustMaxKt(st.tafRaw);
    const metWx = wxFlags(st.metarRaw);
    const tafWx = wxFlags(st.tafRaw);
    const tms = lastTimesFor(icao);
    return {st, metVis, metRvr, metGust, tafVis, tafRvr, tafGust, metWx, tafWx, ...tms};
  });

  rows.sort((a,b)=>{
    const av = sort==="icao" ? a.st.icao.localeCompare(b.st.icao)
           : sort==="chg" ? ((b.lastCh||0)-(a.lastCh||0))
           : ((b.lastDet||0)-(a.lastDet||0));
    return av;
  });

  tb.innerHTML = "";
  for (const r of rows){
    const tr = document.createElement("tr");
    tr.className = "stRow";
    tr.dataset.icao = r.st.icao;
    if (selectedIcao && selectedIcao === r.st.icao) tr.style.background = "rgba(255,255,255,.06)";

    const metWxHtml = r.metWx.length ? `<span class="wxStack">${r.metWx.map(t=>pill(t,"bad")).join("")}</span>` : `<span class="muted">—</span>`;
    const tafWxHtml = r.tafWx.length ? `<span class="wxStack">${r.tafWx.map(t=>pill(t,"bad")).join("")}</span>` : `<span class="muted">—</span>`;

    const cells = [
      r.st.icao,
      r.st.iata || "—",
      r.metVis==null ? "—" : `${r.metVis} m`,
      r.metRvr==null ? "—" : `${r.metRvr} m`,
      r.metGust==null ? "—" : `${r.metGust} kt`,
      metWxHtml,
      r.tafVis==null ? "—" : `${r.tafVis} m`,
      r.tafRvr==null ? "—" : `${r.tafRvr} m`,
      r.tafGust==null ? "—" : `${r.tafGust} kt`,
      tafWxHtml,
      r.lastDet ? fmtUTC(new Date(r.lastDet)) : "—",
      r.lastImp ? fmtUTC(new Date(r.lastImp)) : "—",
      r.lastCh ? fmtUTC(new Date(r.lastCh)) : "—",
    ];

    cells.forEach((c, i)=>{
      const td = document.createElement("td");
      if (typeof c === "string" && (c.includes("<span") || c.includes("<div"))){
        td.innerHTML = c;
      }else{
        td.textContent = c;
      }
      tr.appendChild(td);
    });

    tr.addEventListener("click", ()=>{
      selectedIcao = r.st.icao;
      renderStations();
      renderStationDetail();
    });

    tb.appendChild(tr);
  }

  $("stNote").textContent = `Airports shown: ${rows.length}. Event history is stored locally in this browser (per ICAO).`;
  renderStationDetail();
}

function renderStationDetail(){
  if (!$("stTitle")) return;
  if (!selectedIcao){
    $("stTitle").textContent = "—";
    $("stSub").textContent = "Click a row to view details.";
    $("stEvents").innerHTML = "";
    $("stEmpty").style.display = "block";
    return;
  }
  const st = latestStations.find(x=>x.icao===selectedIcao);
  const iata = st?.iata || stationSnap[selectedIcao]?.iata || "";
  $("stTitle").textContent = `${selectedIcao}${iata ? " / "+iata : ""}`;
  $("stSub").textContent = "Events are recorded when new METAR/TAF arrives (generatedAt changes).";

  const evs = (stationEvents[selectedIcao] || []).slice().reverse();
  const ul = $("stEvents");
  ul.innerHTML = "";
  if (!evs.length){
    $("stEmpty").style.display = "block";
    return;
  }
  $("stEmpty").style.display = "none";
  for (const ev of evs){
    const li = document.createElement("li");
    const f = fmtEv(ev);
    li.innerHTML = `<div class="evTop"><div class="evWhat">${f.what}</div><div class="evWhen">${f.when}</div></div><div class="evSub">${f.sub}</div>`;
    ul.appendChild(li);
  }
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

  latestStations = stations;
  if (isNew && genAt) {
    updateStationHistory(stations, genAt);
  }
  renderStations();

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
  $("btnClearSel")?.addEventListener("click", ()=>{ selectedIcao=null; renderStations(); });
  $("stSearch")?.addEventListener("input", renderStations);
  $("stSort")?.addEventListener("change", renderStations);
  pullOnce();
  setInterval(pullOnce, 60*1000);
}
start();
