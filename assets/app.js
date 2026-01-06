
/* v19: fixes
   - Quick View triggers layout (CSS flex-wrap)
   - Raw highlight overlap fixed via CSS .hl inline-block margins
   - Priority: METAR-driven hazards outrank TAF-only hazards
*/

const $ = (id) => document.getElementById(id);

const VIS_THRESHOLDS = [800, 550, 500, 300, 250, 175, 150];
const RVR_THRESHOLDS = [500, 300, 200, 75];

let stations = [];
let view = {
  q: "",
  cond: "all",
  alert: "all",
  sortPri: true,
};

function escapeHtml(s){
  return (s ?? "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function parseVisibilityMeters(raw){
  if (!raw) return null;
  // METAR: #### or CAVOK (=> 10000)
  if (/\bCAVOK\b/.test(raw)) return 10000;

  // predominant visibility: 4 digits at start after wind group in METAR; for robustness find isolated 4 digits before weather or cloud.
  // Prefer explicit METAR field: ... 2000 ... or 9999 ...
  const m = raw.match(/\b(\d{4})\b(?!\/)/); // avoid RVR like R27/0600
  if (m){
    const v = parseInt(m[1],10);
    if (!Number.isNaN(v)) return v;
  }
  // TAF can have "5000" etc - same rule.
  return null;
}

function extractAllVisibilityMetersFromTAF(raw){
  if (!raw) return [];
  const vals = [];
  if (/\bCAVOK\b/.test(raw)) vals.push(10000);
  const re = /\b(\d{4})\b(?!\/)/g;
  let m;
  while ((m = re.exec(raw)) !== null){
    const v = parseInt(m[1],10);
    if (!Number.isNaN(v)) vals.push(v);
  }
  return vals;
}

function extractRvrMeters(raw){
  if (!raw) return [];
  const re = /\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g;
  const vals = [];
  let m;
  while ((m = re.exec(raw)) !== null){
    const v1 = parseInt(m[2],10);
    if (!Number.isNaN(v1)) vals.push(v1);
    if (m[4]){
      const v2 = parseInt(m[4],10);
      if (!Number.isNaN(v2)) vals.push(v2);
    }
  }
  return vals;
}

function ceilingFt(raw){
  if (!raw) return null;
  // BKN/OVC### or VV### where ### is hundreds of feet
  const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let min = null;
  let m;
  while ((m = re.exec(raw)) !== null){
    const h = parseInt(m[2],10);
    if (!Number.isNaN(h)){
      const ft = h*100;
      if (min === null || ft < min) min = ft;
    }
  }
  return min;
}

function hasAny(raw, tokens){
  if (!raw) return false;
  return tokens.some(t => new RegExp(`\\b${t}\\b`).test(raw));
}

function hazardFlags(raw){
  return {
    fzfg: /\bFZFG\b/.test(raw),
    fg: /\bFG\b/.test(raw),
    br: /\bBR\b/.test(raw),
    sn: /\bSN\b/.test(raw) || /\bSHSN\b/.test(raw),
    ra: /\bRA\b/.test(raw) || /\bDZ\b/.test(raw),
    ts: /\bTS\b/.test(raw) || /\bTSRA\b/.test(raw) || /\bTSGR\b/.test(raw),
  };
}

function computeScores(raw){
  const vis = parseVisibilityMeters(raw);
  const rvr = extractRvrMeters(raw);
  const rvrMin = rvr.length ? Math.min(...rvr) : null;
  const cig = ceilingFt(raw);
  const hz = hazardFlags(raw);

  let score = 0;

  // Visibility contribution
  if (vis !== null){
    if (vis <= 150) score += 35;
    else if (vis <= 175) score += 30;
    else if (vis <= 250) score += 26;
    else if (vis <= 300) score += 24;
    else if (vis <= 500) score += 18;
    else if (vis <= 550) score += 16;
    else if (vis <= 800) score += 12;
  }

  // RVR contribution
  if (rvrMin !== null){
    if (rvrMin <= 75) score += 28;
    else if (rvrMin <= 200) score += 22;
    else if (rvrMin <= 300) score += 18;
    else if (rvrMin <= 500) score += 12;
  }

  // Ceiling contribution
  if (cig !== null){
    if (cig < 500) score += 22;
    else if (cig < 800) score += 12;
  }

  // Wx triggers
  if (hz.ts) score += 22;
  if (hz.fzfg) score += 18;
  if (hz.fg) score += 14;
  if (hz.sn) score += 10;
  if (hz.ra) score += 8;
  if (hz.br) score += 6;

  // cap-ish
  score = Math.min(100, score);

  return {vis, rvrMin, cig, hz, score};
}

function deriveStation(st){
  const met = computeScores(st.metarRaw || "");
  const taf = computeScores(st.tafRaw || "");

  const worstVis = (() => {
    const vals = [];
    if (met.vis !== null) vals.push(met.vis);
    // TAF: could have multiple vis values; use min extracted to represent worst
    const tafVals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tafVals.length) vals.push(Math.min(...tafVals));
    return vals.length ? Math.min(...vals) : null;
  })();

  const allRvr = [...extractRvrMeters(st.metarRaw || ""), ...extractRvrMeters(st.tafRaw || "")];
  const rvrMinAll = allRvr.length ? Math.min(...allRvr) : null;

  const cigAll = (() => {
    const a = ceilingFt(st.metarRaw || "");
    const b = ceilingFt(st.tafRaw || "");
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a,b);
  })();

  // ENG ICE OPS condition based on METAR visibility + METAR FZFG (operationally "now")
  const engIceOps = (met.vis !== null && met.vis <= 150 && met.hz.fzfg);

  // severity score (combined but METAR has higher weight)
  let severityScore = Math.max(met.score, Math.floor(taf.score*0.85));
  if (engIceOps) severityScore = 100;

  const alert = severityScore >= 70 ? "CRIT" :
                severityScore >= 45 ? "HIGH" :
                severityScore >= 20 ? "MED" : "OK";

  // Priority: METAR outranks TAF
  // Primary sort key uses METAR score, then TAF score
  const metPri = engIceOps ? 1000 : met.score; // 1000 = pinned
  const tafPri = taf.score;

  // Determine triggers & source (M/T)
  const triggers = [];
  const push = (label, cls, src) => triggers.push({label, cls, src}); // src: "M","T","MT"
  const addBy = (label, cls, m, t) => {
    if (!m && !t) return;
    const src = m && t ? "MT" : (m ? "M" : "T");
    push(label, cls, src);
  };

  // VIS thresholds for worstVis
  for (const th of VIS_THRESHOLDS){
    const m = (met.vis !== null && met.vis <= th);
    const t = (() => {
      const vals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
      return vals.length ? Math.min(...vals) <= th : false;
    })();
    if (m || t){
      addBy(`VIS≤${th}`, "tag--vis", m, t);
      break; // show only tightest bucket
    }
  }

  // RVR buckets
  if (rvrMinAll !== null){
    for (const th of RVR_THRESHOLDS){
      const m = extractRvrMeters(st.metarRaw || "").some(v => v <= th);
      const t = extractRvrMeters(st.tafRaw || "").some(v => v <= th);
      if (m || t){
        addBy(`RVR≤${th}`, "tag--rvr", m, t);
        break;
      }
    }
  }

  // CIG<500
  addBy("CIG<500", "tag--cig",
        (ceilingFt(st.metarRaw || "") !== null && ceilingFt(st.metarRaw || "") < 500),
        (ceilingFt(st.tafRaw || "") !== null && ceilingFt(st.tafRaw || "") < 500));

  // Wx
  const mhz = met.hz, thz = taf.hz;
  addBy("TS", "tag--wx", mhz.ts, thz.ts);
  addBy("FZFG", "tag--wx", mhz.fzfg, thz.fzfg);
  addBy("FG", "tag--wx", mhz.fg, thz.fg);
  addBy("BR", "tag--wx", mhz.br, thz.br);
  addBy("SN", "tag--wx", mhz.sn, thz.sn);
  addBy("RA", "tag--wx", mhz.ra, thz.ra);

  // ENG ICE OPS tag: show source METAR (M) by design
  if (engIceOps){
    triggers.unshift({label:"ENG ICE OPS", cls:"tag--eng", src:"M"});
  }

  return {
    ...st,
    met, taf,
    worstVis,
    rvrMinAll,
    cigAll,
    engIceOps,
    severityScore,
    alert,
    metPri,
    tafPri,
    triggers
  };
}

function ageClass(mins){
  if (mins === null || mins === undefined) return "age--stale";
  if (mins <= 20) return "age--fresh";
  if (mins <= 60) return "age--warn";
  return "age--stale";
}

function formatAge(mins){
  if (mins === null || mins === undefined) return "—";
  return `${Math.round(mins)}m`;
}

function highlightRaw(raw){
  // escape
  let s = escapeHtml(raw || "");

  // RVR
  s = s.replace(/\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g, (m, p1, v1, p2, v2) => {
    const nums = [v1, v2].filter(Boolean).map(x=>parseInt(x,10)).filter(n=>!Number.isNaN(n));
    const minv = nums.length ? Math.min(...nums) : null;
    let cls = "hl-rvr-500";
    if (minv !== null){
      if (minv <= 75) cls = "hl-rvr-75";
      else if (minv <= 200) cls = "hl-rvr-200";
      else if (minv <= 300) cls = "hl-rvr-300";
      else if (minv <= 500) cls = "hl-rvr-500";
    }
    return `<span class="hl ${cls}" data-cat="rvr">${m}</span>`;
  });

  // CIG tokens
  s = s.replace(/\b(BKN|OVC|VV)(\d{3})\b/g, (m, typ, h) => {
    const ft = parseInt(h,10)*100;
    if (!Number.isNaN(ft) && ft < 500){
      return `<span class="hl" data-cat="cig">${m}</span>`;
    }
    return m;
  });

  // Wx hazards
  const hazardMap = [
    {re:/\bTS\w*\b/g, cls:"hl-wx-ts"},
    {re:/\b(FZFG|FG)\b/g, cls:"hl-wx-fog"},
    {re:/\bBR\b/g, cls:"hl-wx-fog"},
    {re:/\b(SN|SHSN)\b/g, cls:"hl-wx-snow"},
    {re:/\b(RA|DZ)\b/g, cls:"hl-wx-rain"},
  ];
  for (const h of hazardMap){
    s = s.replace(h.re, (m)=>`<span class="hl ${h.cls}" data-cat="wx">${m}</span>`);
  }

  // Visibility numeric tokens — only highlight when low
  // Find 4-digit vis values (exclude RVR already handled by (?!\/))
  s = s.replace(/\b(\d{4})\b(?!\/)/g, (m, d) => {
    const v = parseInt(d,10);
    if (Number.isNaN(v)) return m;
    let cls = null;
    if (v <= 150) cls = "hl-vis-150";
    else if (v <= 175) cls = "hl-vis-175";
    else if (v <= 250) cls = "hl-vis-250";
    else if (v <= 300) cls = "hl-vis-300";
    else if (v <= 500) cls = "hl-vis-500";
    else if (v <= 550) cls = "hl-vis-550";
    else if (v <= 800) cls = "hl-vis-800";
    if (!cls) return m;
    return `<span class="hl ${cls}" data-cat="vis">${m}</span>`;
  });

  return s;
}

function decodeMetar(raw){
  if (!raw) return "";
  const out = [];
  // wind
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  // visibility
  if (/\bCAVOK\b/.test(raw)) out.push("Visibility: 10 km or more");
  else{
    const v = parseVisibilityMeters(raw);
    if (v !== null) out.push(`Visibility: ${v >= 10000 ? "10 km or more" : (v + " m")}`);
  }
  // wx
  const wx = [];
  if (/\bFZFG\b/.test(raw)) wx.push("Freezing fog");
  else if (/\bFG\b/.test(raw)) wx.push("Fog");
  if (/\bBR\b/.test(raw)) wx.push("Mist");
  if (/\b(SN|SHSN)\b/.test(raw)) wx.push("Snow");
  if (/\b(RA|DZ)\b/.test(raw)) wx.push("Rain/Drizzle");
  if (/\bTS\b/.test(raw)) wx.push("Thunderstorm");
  if (wx.length) out.push(`Weather: ${wx.join(", ")}`);

  // temp/dew
  const td = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (td){
    const t = td[1].replace(/^M/,"-");
    const d = td[2].replace(/^M/,"-");
    out.push(`Temp/Dew point: ${t}°C / ${d}°C`);
  }
  // qnh
  const q = raw.match(/\bQ(\d{4})\b/);
  if (q) out.push(`QNH: ${q[1]} hPa`);

  // ceiling
  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Ceiling: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function decodeTaf(raw){
  if (!raw) return "";
  const out = [];
  // valid period
  const vp = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (vp) out.push(`Valid: day ${vp[1]} ${vp[2]}Z → day ${vp[3]} ${vp[4]}Z`);
  // headline wind
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  // worst vis
  const vals = extractAllVisibilityMetersFromTAF(raw);
  if (/\bCAVOK\b/.test(raw)) out.push("Visibility: CAVOK");
  else if (vals.length){
    out.push(`Worst visibility in TAF: ${Math.min(...vals)} m`);
  }
  // notable groups
  const groups = [];
  if (/\bTEMPO\b/.test(raw)) groups.push("TEMPO");
  if (/\bBECMG\b/.test(raw)) groups.push("BECMG");
  if (/\bPROB\d{2}\b/.test(raw)) groups.push("PROB");
  if (groups.length) out.push(`Change groups: ${groups.join(", ")}`);

  // hazards
  const hz = hazardFlags(raw);
  const wx = [];
  if (hz.ts) wx.push("TS");
  if (hz.fzfg) wx.push("FZFG");
  if (hz.fg) wx.push("FG");
  if (hz.br) wx.push("BR");
  if (hz.sn) wx.push("SN");
  if (hz.ra) wx.push("RA/DZ");
  if (wx.length) out.push(`Weather signals: ${wx.join(", ")}`);

  // ceiling
  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Lowest ceiling in TAF: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function trendPill(icao, currentVis){
  const key = `wxm_prev_vis_${icao}`;
  const prev = localStorage.getItem(key);
  localStorage.setItem(key, currentVis === null ? "" : String(currentVis));
  if (prev === null || prev === "") return {text:"NEW", cls:"trend--new"};
  const p = parseInt(prev,10);
  if (Number.isNaN(p) || currentVis === null) return {text:"NEW", cls:"trend--new"};
  if (currentVis < p) return {text:"▼", cls:"trend--down"};
  if (currentVis > p) return {text:"▲", cls:"trend--up"};
  return {text:"•0", cls:"trend--flat"};
}

function visBucket(vis){
  if (vis === null) return null;
  for (const th of VIS_THRESHOLDS){
    if (vis <= th) return th;
  }
  return null;
}

function buildLowVisTag(st){
  const b = visBucket(st.worstVis);
  if (!b) return "—";
  return `VIS≤${b}`;
}

function rowHtml(st){
  const vis = (st.met.vis !== null ? st.met.vis : (st.worstVis ?? null));
  const trend = trendPill(st.icao, vis ?? null);
  const lowVis = buildLowVisTag(st);

  const trigHtml = st.triggers.map(t=>{
    const srcBadge = t.src ? `<span class="tag tag--src">${t.src === "MT" ? "M+T" : t.src}</span>` : "";
    return `<span class="tag ${t.cls || ""}" data-icao="${st.icao}" data-open="1">${escapeHtml(t.label)} ${srcBadge}</span>`;
  }).join("");

  const metAge = `<span class="age ${ageClass(st.metarAgeMin)}">${escapeHtml(formatAge(st.metarAgeMin))}</span>`;
  const tafAge = `<span class="age ${ageClass(st.tafAgeMin)}">${escapeHtml(formatAge(st.tafAgeMin))}</span>`;

  const metRaw = st.metarRaw ? highlightRaw(st.metarRaw) : "<span class='muted'>—</span>";
  const tafRaw = st.tafRaw ? highlightRaw(st.tafRaw) : "<span class='muted'>—</span>";

  return `<tr class="row" data-icao="${escapeHtml(st.icao)}">
    <td>
      <div class="airport">
        <div class="airport__codes">
          <div class="airport__icao">${escapeHtml(st.icao)}</div>
          <div class="airport__iata">${escapeHtml((st.iata||"—").toUpperCase())}</div>
        </div>
        <div class="airport__name">${escapeHtml(st.name||"")}</div>
      </div>
    </td>
    <td><span class="pill pill--${st.alert.toLowerCase()}">${escapeHtml(st.alert)}</span></td>
    <td>
      <span class="mono">${escapeHtml(String(vis ?? (st.met.vis ?? st.worstVis ?? "—")))}</span>
      <span class="trend ${trend.cls}">${trend.text}</span>
    </td>
    <td><span class="tag tag--vis">${escapeHtml(lowVis)}</span></td>
    <td><div class="triggers">${trigHtml}</div></td>
    <td>${metAge}</td>
    <td>${tafAge}</td>
    <td><div class="raw">${metRaw}</div></td>
    <td><div class="raw">${tafRaw}</div></td>
  </tr>`;
}

function applyFilters(list){
  const q = view.q.trim().toUpperCase();
  const cond = view.cond;
  const alert = view.alert;

  return list.filter(st=>{
    if (q){
      const hay = `${st.icao} ${(st.iata||"")} ${(st.name||"")}`.toUpperCase();
      if (!hay.includes(q)) return false;
    }
    if (alert !== "all" && st.alert !== alert) return false;

    switch(cond){
      case "all": break;
      case "eng": if (!st.engIceOps) return false; break;
      case "crit": if (st.alert !== "CRIT") return false; break;
      case "high": if (st.alert !== "HIGH") return false; break;
      case "med": if (st.alert !== "MED") return false; break;

      case "vis800": if (!(st.worstVis !== null && st.worstVis <= 800)) return false; break;
      case "vis550": if (!(st.worstVis !== null && st.worstVis <= 550)) return false; break;
      case "vis500": if (!(st.worstVis !== null && st.worstVis <= 500)) return false; break;
      case "vis300": if (!(st.worstVis !== null && st.worstVis <= 300)) return false; break;
      case "vis250": if (!(st.worstVis !== null && st.worstVis <= 250)) return false; break;
      case "vis175": if (!(st.worstVis !== null && st.worstVis <= 175)) return false; break;
      case "vis150": if (!(st.worstVis !== null && st.worstVis <= 150)) return false; break;

      case "rvr500": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 500)) return false; break;
      case "rvr300": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 300)) return false; break;
      case "rvr200": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 200)) return false; break;
      case "rvr75":  if (!(st.rvrMinAll !== null && st.rvrMinAll <= 75)) return false; break;

      case "fog":
        if (!(st.met.hz.fg || st.met.hz.br || st.met.hz.fzfg || st.taf.hz.fg || st.taf.hz.br || st.taf.hz.fzfg)) return false;
        break;
      case "snow":
        if (!(st.met.hz.sn || st.taf.hz.sn)) return false;
        break;
      case "rain":
        if (!(st.met.hz.ra || st.taf.hz.ra)) return false;
        break;
      case "ts":
        if (!(st.met.hz.ts || st.taf.hz.ts)) return false;
        break;
      case "cig500":
        if (!(st.cigAll !== null && st.cigAll < 500)) return false;
        break;
      default: break;
    }

    return true;
  });
}

function sortList(list){
  if (!view.sortPri){
    return [...list].sort((a,b)=> a.icao.localeCompare(b.icao));
  }
  return [...list].sort((a,b)=>{
    // 1) ENG ICE OPS pinned
    if (a.engIceOps !== b.engIceOps) return a.engIceOps ? -1 : 1;
    // 2) METAR priority (current)
    if (b.metPri !== a.metPri) return b.metPri - a.metPri;
    // 3) TAF priority
    if (b.tafPri !== a.tafPri) return b.tafPri - a.tafPri;
    // 4) Severity
    if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
    // 5) ICAO
    return a.icao.localeCompare(b.icao);
  });
}

function updateTiles(currentList){
  const eng = currentList.filter(s=>s.engIceOps);
  const crit = currentList.filter(s=>s.alert==="CRIT");
  const vis175 = currentList.filter(s=>s.worstVis !== null && s.worstVis <= 175);
  const ts = currentList.filter(s=>s.met.hz.ts || s.taf.hz.ts);

  $("tileEngCount").textContent = String(eng.length);
  $("tileCritCount").textContent = String(crit.length);
  $("tileVis175Count").textContent = String(vis175.length);
  $("tileTsCount").textContent = String(ts.length);

  // ENG ICE OPS IATA list (max 10)
  const iatas = eng.map(s => (s.iata||"—").toUpperCase()).filter(x=>x && x!=="—");
  const shown = iatas.slice(0,10);
  const rest = iatas.length - shown.length;
  $("tileEngIata").innerHTML = shown.map(x=>`<span>${escapeHtml(x)}</span>`).join("") + (rest>0 ? `<span>+${rest}</span>` : "");
}

function render(){
  const tbody = $("rows");
  const filtered = applyFilters(stations);
  const sorted = sortList(filtered);

  updateTiles(sorted);

  if (!sorted.length){
    tbody.innerHTML = `<tr><td colspan="9" class="muted">No matching rows.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(rowHtml).join("");

  // row click and tag click opens drawer
  tbody.querySelectorAll("tr.row").forEach(tr=>{
    tr.addEventListener("click", (ev)=>{
      // if clicked on a link-like element, still open
      const icao = tr.getAttribute("data-icao");
      openDrawer(icao);
    });
  });
  tbody.querySelectorAll("[data-open='1']").forEach(el=>{
    el.addEventListener("click", (ev)=>{
      ev.stopPropagation();
      const icao = el.getAttribute("data-icao");
      openDrawer(icao);
    });
  });
}

function openDrawer(icao){
  const st = stations.find(s=>s.icao === icao);
  if (!st) return;

  $("dAirport").textContent = `${st.icao} ${(st.iata||"—").toUpperCase()}`;
  $("dSub").textContent = st.name || "";

  $("dAlert").textContent = st.alert;
  $("dSev").textContent = String(st.severityScore);
  $("dVis").textContent = st.met.vis !== null ? `${st.met.vis} m` : "—";
  $("dWorstVis").textContent = st.worstVis !== null ? `${st.worstVis} m` : "—";
  $("dRvr").textContent = st.rvrMinAll !== null ? `${st.rvrMinAll} m` : "—";
  $("dCig").textContent = st.cigAll !== null ? `${st.cigAll} ft` : "—";
  $("dMetAge").textContent = formatAge(st.metarAgeMin);
  $("dTafAge").textContent = formatAge(st.tafAgeMin);

  // triggers in drawer — fixed: always flex-wrap container; no overlapping
  $("dTriggers").innerHTML = st.triggers.map(t=>{
    const src = t.src ? `<span class="tag tag--src">${t.src==="MT"?"M+T":t.src}</span>` : "";
    return `<span class="tag ${t.cls||""}">${escapeHtml(t.label)} ${src}</span>`;
  }).join("");

  $("dMetRaw").innerHTML = st.metarRaw ? highlightRaw(st.metarRaw) : "—";
  $("dTafRaw").innerHTML = st.tafRaw ? highlightRaw(st.tafRaw) : "—";

  $("dMetDec").innerHTML = decodeMetar(st.metarRaw || "");
  $("dTafDec").innerHTML = decodeTaf(st.tafRaw || "");

  $("copyBrief").onclick = async () => {
    const line = buildBriefingLine(st);
    try{
      await navigator.clipboard.writeText(line);
      $("copyBrief").textContent = "Copied";
      setTimeout(()=> $("copyBrief").textContent = "Copy briefing line", 900);
    }catch{
      // fallback
      const ta = document.createElement("textarea");
      ta.value = line;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      $("copyBrief").textContent = "Copied";
      setTimeout(()=> $("copyBrief").textContent = "Copy briefing line", 900);
    }
  };

  // open
  $("drawer").classList.add("is-open");
  $("drawer").setAttribute("aria-hidden","false");
  $("scrim").hidden = false;
}

function closeDrawer(){
  $("drawer").classList.remove("is-open");
  $("drawer").setAttribute("aria-hidden","true");
  $("scrim").hidden = true;
}

function buildBriefingLine(st){
  const parts = [];
  parts.push(`${st.icao}/${(st.iata||"—").toUpperCase()}`);
  parts.push(`ALERT ${st.alert} (sev ${st.severityScore})`);
  if (st.engIceOps) parts.push("ENG ICE OPS");
  if (st.met.vis !== null) parts.push(`METAR VIS ${st.met.vis}m`);
  if (st.worstVis !== null) parts.push(`WORST VIS ${st.worstVis}m`);
  if (st.rvrMinAll !== null) parts.push(`RVRmin ${st.rvrMinAll}m`);
  if (st.cigAll !== null) parts.push(`CIG ${st.cigAll}ft`);
  const trig = st.triggers.map(t=>`${t.label}${t.src?`(${t.src})`:""}`).join(",");
  if (trig) parts.push(`TRG ${trig}`);
  return parts.join(" | ");
}

async function load(){
  const tbody = $("rows");
  try{
    const res = await fetch("data/latest.json?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const gen = data.generatedAt ? new Date(data.generatedAt) : null;
    $("statUpdated").textContent = (gen && !isNaN(gen.getTime())) ? `Last update: ${gen.toISOString().replace('T',' ').slice(0,16)}Z` : "Last update: —";

    const rawStations = Array.isArray(data.stations) ? data.stations : [];
    stations = rawStations.map(s => ({
      icao: (s.icao || s.station || "").toUpperCase(),
      iata: (s.iata || "").toUpperCase(),
      name: s.name || s.airportName || "",
      metarRaw: s.metarRaw || s.metar || "",
      tafRaw: s.tafRaw || s.taf || "",
      metarAgeMin: s.metarAgeMin ?? s.metarAge ?? null,
      tafAgeMin: s.tafAgeMin ?? s.tafAge ?? null,
    })).filter(s=>s.icao && s.icao.length===4).map(deriveStation);

    const metCnt = stations.filter(s=>!!s.metarRaw).length;
    const tafCnt = stations.filter(s=>!!s.tafRaw).length;
    const missMet = stations.length - metCnt;
    const missTaf = stations.length - tafCnt;
    $("statCounts").textContent = `ICAO: ${stations.length} | METAR: ${metCnt} | TAF: ${tafCnt} | Missing METAR: ${missMet} | Missing TAF: ${missTaf}`;

    render();
  }catch(err){
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="9" class="muted">Data load error: ${escapeHtml(String(err))}. Ensure data/latest.json exists and is valid.</td></tr>`;
    $("statCounts").textContent = "ICAO: 0 | METAR: 0 | TAF: 0";
    $("statUpdated").textContent = "Last update: —";
    updateTiles([]);
  }
}

function bind(){
  $("q").addEventListener("input", (e)=>{ view.q = e.target.value; render(); });
  $("cond").addEventListener("change", (e)=>{ view.cond = e.target.value; render(); });
  $("alert").addEventListener("change", (e)=>{ view.alert = e.target.value; render(); });
  $("sortPri").addEventListener("change", (e)=>{ view.sortPri = e.target.checked; render(); });

  // tile filters
  $("tiles").addEventListener("click", (e)=>{
    const btn = e.target.closest("button.tile");
    if (!btn) return;
    if (btn.id === "tileReset"){
      view.q=""; view.cond="all"; view.alert="all"; view.sortPri=true;
      $("q").value=""; $("cond").value="all"; $("alert").value="all"; $("sortPri").checked=true;
      render();
      return;
    }
    const f = btn.getAttribute("data-filter");
    if (!f) return;
    // toggle: clicking same filter again resets to all
    const map = {eng:"eng", crit:"crit", vis175:"vis175", ts:"ts"};
    const target = map[f] || "all";
    view.cond = (view.cond === target ? "all" : target);
    $("cond").value = view.cond;
    render();
  });

  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown",(e)=>{ if (e.key==="Escape") closeDrawer(); });

  // refresh "age" every minute without refetch
  setInterval(()=>{ render(); }, 60_000);
}

bind();
load();
