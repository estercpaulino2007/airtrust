/* AirTrust command center — vanilla JS, no build step. */
(() => {
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(+v) ? "–" : (+v).toFixed(d));
const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-6)}` : "–");
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const dt = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const label = (s) => String(s || "").replace(/_/g, " ");
const THRESH = {
  pm25: [15, 25, 37.5, 75], pm10: [45, 60, 90, 180], no2: [25, 50, 100, 200], o3: [100, 120, 160, 240], temperature: [28, 31, 34, 37],
};
const LEVELS = ["good", "moderate", "poor", "very_poor", "critical"];
const LEVEL_ICON = { good: "▾", moderate: "◆", poor: "▲", very_poor: "▲▲", critical: "⚠" };
const UNITS = { pm25: "µg/m³", pm10: "µg/m³", no2: "µg/m³", o3: "µg/m³", temperature: "°C" };
const POL_LABEL = { pm25: "PM2.5", pm10: "PM10", no2: "NO₂", o3: "O₃", temperature: "Temperature" };
const level = (pol, v) => { const t = THRESH[pol] || THRESH.pm25; const i = t.findIndex((x) => v <= x); return LEVELS[i === -1 ? 4 : i]; };
const color = (lvl) => getComputedStyle(document.documentElement).getPropertyValue(`--risk-${lvl}`).trim() || "#22e5a1";
const EVENT_ICON = { wildfire_smoke: "🔥", industrial_emission: "🏭", dust_event: "🌪", traffic_pollution: "🚗", heatwave: "🌡", sensor_fault: "🛠", unknown_anomaly: "❔" };

const S = {
  token: null, user: null, pol: "pm25", sensors: [], latest: {}, spark: {}, events: [], alerts: [], reports: [], selected: null,
  layers: { heat: true, wind: true, reports: true, events: true, labels: true }, feed: [], ledger: null, lastVerify: null, tamper: null,
};
try { const saved = JSON.parse(sessionStorage.getItem("airtrust_session") || "null"); if (saved) { S.token = saved.token; S.user = saved.user; } } catch {}
try { if (localStorage.getItem("airtrust_theme") === "light") document.documentElement.dataset.theme = "light"; } catch {}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || res.statusText), { status: res.status });
  return data;
}

function toast(title, body = "", tone = "info") {
  const c = { info: "var(--accent-primary)", success: "var(--accent-success)", warning: "var(--accent-warning)", critical: "var(--accent-critical)" }[tone];
  const el = document.createElement("div");
  el.className = "toast"; el.style.setProperty("--tc", c);
  el.innerHTML = `<b>${esc(title)}</b><span class="muted">${esc(body)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; setTimeout(() => el.remove(), 400); }, 5200);
}

function countUp(el, to, d = 0) {
  const from = parseFloat(el.dataset.v || "0") || 0;
  el.dataset.v = to;
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / 600); el.textContent = (from + (to - from) * (1 - Math.pow(1 - p, 3))).toFixed(d); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function sparkline(values, col = "var(--accent-primary)", h = 34) {
  if (!values.length) return `<svg class="spark" viewBox="0 0 100 ${h}"></svg>`;
  const min = Math.min(...values), max = Math.max(...values), rng = max - min || 1;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${h - 3 - ((v - min) / rng) * (h - 6)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><polyline points="0,${h} ${pts} 100,${h}" fill="${col}" opacity=".08"/></svg>`;
}

// --------------------------------------------------------------------- boot
async function boot() {
  const lines = $("#bootLines"), bar = $("#bootBar");
  const add = (txt, status, cls = "ok") => { const d = document.createElement("div"); d.className = "boot-line"; d.innerHTML = `<span>${esc(txt)}</span><span class="${cls}">${esc(status)}</span>`; lines.appendChild(d); requestAnimationFrame(() => d.classList.add("show")); };
  let health = null;
  try { health = await api("/api/health"); } catch {}
  const steps = [
    () => add("Establishing telemetry uplink", "OK"),
    () => add(`Sensor mesh · Istanbul`, health ? `${health.sensors_online}/${health.sensors_total} ONLINE` : "UNREACHABLE", health ? "ok" : "warn"),
    () => add("AI climate engine · 7 detection methods", health ? `ACTIVE · ${health.ai_latency_ms} ms` : "STANDBY", health ? "ok" : "warn"),
    () => add("Trust ledger · AirTrustLedger.sol", health?.ledger?.connected ? `CONNECTED · BLOCK #${health.ledger.block}` : "OFFLINE", health?.ledger?.connected ? "ok" : "warn"),
    () => add("Data provenance", "SIMULATED · LABELLED", "warn"),
  ];
  for (let i = 0; i < steps.length; i++) { steps[i](); bar.style.width = `${((i + 1) / steps.length) * 100}%`; await new Promise((r) => setTimeout(r, 330)); }
  await new Promise((r) => setTimeout(r, 380));
  $("#boot").classList.add("done");
  setTimeout(() => { $("#boot").remove(); if (map) fitSensors(); }, 700);
}

// ---------------------------------------------------------------------- map
let map, markers = {}, heat = {}, wind = {}, reportLayer, eventLayer;
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25, zoomDelta: 0.5 }).setView([41.03, 28.97], 10.5);
  addBasemap(map);
  reportLayer = L.layerGroup().addTo(map);
  eventLayer = L.layerGroup().addTo(map);
  map.zoomControl.setPosition("bottomright");
}
/**
 * Dark basemap without any API key: Esri "Dark Gray Canvas" (base + labels).
 * If those tiles fail to load, fall back to OpenStreetMap tiles darkened with a CSS filter.
 */
function addBasemap(m) {
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  const base = L.tileLayer(esri + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }).addTo(m);
  const labels = L.tileLayer(esri + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "overlayPane", opacity: 0.85 }).addTo(m);
  let errors = 0, switched = false;
  base.on("tileerror", () => {
    if (switched || ++errors < 4) return;
    switched = true;
    m.removeLayer(base); m.removeLayer(labels);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className: "osm-dark", attribution: "&copy; OpenStreetMap contributors" }).addTo(m);
  });
}

function fitSensors() {
  if (!S.sensors.length) return;
  map.invalidateSize();
  map.fitBounds(L.latLngBounds(S.sensors.map((s) => [s.latitude, s.longitude])), { padding: [70, 70], maxZoom: 13 });
}

function sensorState(code) {
  const s = S.sensors.find((x) => x.code === code);
  const r = S.latest[code];
  if (!s) return {};
  if (s.status === "offline" || !r) return { cls: "off", lvl: "maintenance", value: null };
  if (r.ai_status === "sensor_fault" || s.status === "fault") return { cls: "fault", lvl: "maintenance", value: r[S.pol] };
  const lvl = level(S.pol, r[S.pol]);
  return { cls: r.ai_status === "suspicious" ? "suspicious" : r.ai_status === "anomalous" ? "anom" : "", lvl, value: r[S.pol] };
}

function renderMarker(code) {
  const s = S.sensors.find((x) => x.code === code);
  const st = sensorState(code);
  const r = S.latest[code];
  const c = st.cls === "off" || st.cls === "fault" ? "#475569" : color(st.lvl);
  const spd = r?.anomaly_score >= 70 ? "0.9s" : r?.anomaly_score >= 50 ? "1.4s" : "2.6s";
  const html = `<div class="smark ${st.cls}" style="--c:${c};--spd:${spd}"><div class="pulse"></div><div class="core"></div>${S.layers.labels ? `<div class="lbl">${code}${st.value != null ? " · " + fmt(st.value, 0) : ""}</div>` : ""}</div>`;
  const icon = L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] });
  const tip = `<b>${esc(s.code)} · ${esc(s.name)}</b><br><span class="muted">${esc(s.district)}</span><br>${r ? `${POL_LABEL[S.pol]} <b>${fmt(r[S.pol])}</b> ${UNITS[S.pol]} · <span class="pill ${esc(r.ai_status)}">${label(r.ai_status)}</span><br>Confidence ${r.confidence_score}% · anomaly ${r.anomaly_score}` : "<b>offline</b>"}`;
  if (!markers[code]) {
    markers[code] = L.marker([s.latitude, s.longitude], { icon, keyboard: true, title: `${s.code} ${s.name}`, alt: `${s.code} ${st.lvl}` }).addTo(map).on("click", () => openSensor(code));
    markers[code].bindTooltip(tip, { direction: "top", offset: [0, -10] });
  } else { markers[code].setIcon(icon); markers[code].setTooltipContent(tip); }

  // pollution heat blob
  if (heat[code]) { heat[code].remove(); delete heat[code]; }
  if (S.layers.heat && st.value != null && st.cls !== "fault") {
    const rel = Math.min(4, st.value / (THRESH[S.pol]?.[0] || 15));
    heat[code] = L.circle([s.latitude, s.longitude], { radius: 900 + rel * 900, stroke: false, fillColor: color(st.lvl), fillOpacity: 0.07 + Math.min(0.22, rel * 0.05), interactive: false }).addTo(map);
  }
  // wind arrow (points downwind)
  if (wind[code]) { wind[code].remove(); delete wind[code]; }
  if (S.layers.wind && r && st.cls !== "off") {
    const to = (r.wind_direction + 180) % 360;
    const off = 0.012;
    const lat = s.latitude + Math.cos((to * Math.PI) / 180) * off, lng = s.longitude + Math.sin((to * Math.PI) / 180) * off;
    wind[code] = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: `<div class="wind" style="transform:rotate(${to}deg)" aria-hidden="true">➤</div>`.replace("➤", "↑"), iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false }).addTo(map);
  }
}

function renderReportsOnMap() {
  reportLayer.clearLayers();
  if (!S.layers.reports) return;
  const since = Date.now() - 6 * 3.6e6;
  for (const r of S.reports.filter((x) => Date.parse(x.created_at) > since).slice(0, 30)) {
    const icon = L.divIcon({ className: "", html: `<div class="rmark"><span>${r.type === "heat" ? "🌡" : r.type === "dust" ? "≋" : r.type === "traffic" ? "🚗" : "☁"}</span></div>`, iconSize: [18, 18], iconAnchor: [4, 18] });
    L.marker([r.latitude, r.longitude], { icon, title: `Citizen report ${r.code}` }).addTo(reportLayer)
      .bindTooltip(`<b>${esc(r.code)} · ${esc(r.type)}</b><br>${esc(r.description || "")}<br>AI correlation <b>${r.ai_correlation_score ?? "…"}</b>/100`, { direction: "top" });
  }
}

function renderEventsOnMap() {
  eventLayer.clearLayers();
  if (!S.layers.events) return;
  for (const e of S.events.filter((x) => !x.ended_at && x.status !== "dismissed")) {
    const pts = e.sensor_codes.map((c) => S.sensors.find((s) => s.code === c)).filter(Boolean);
    if (!pts.length) continue;
    const lat = pts.reduce((a, s) => a + s.latitude, 0) / pts.length, lng = pts.reduce((a, s) => a + s.longitude, 0) / pts.length;
    const radius = e.type === "heatwave" ? 14000 : 2500 + pts.length * 900;
    const col = e.status === "verified" ? "#ff2d55" : "#ffb020";
    L.circle([lat, lng], { radius, color: col, weight: 1.5, dashArray: "6 6", fillColor: col, fillOpacity: 0.06 }).addTo(eventLayer)
      .bindTooltip(`<b>${EVENT_ICON[e.type] || ""} ${esc(e.title)}</b><br>${label(e.status)} · ${Math.round(e.confidence_score)}% confidence`, { sticky: true })
      .on("click", () => showView("events"));
  }
}

// ------------------------------------------------------------ sensor list
function renderSensorList() {
  const list = $("#sensorList");
  list.innerHTML = S.sensors.map((s) => {
    const st = sensorState(s.code);
    const r = S.latest[s.code];
    const c = st.cls === "off" || st.cls === "fault" ? "#475569" : color(st.lvl);
    const tag = st.cls === "off" ? "offline" : st.cls === "fault" ? "fault" : r?.ai_status === "suspicious" ? "review" : `${LEVEL_ICON[st.lvl]} ${label(st.lvl)}`;
    return `<button class="sensor-row ${S.selected === s.code ? "sel" : ""}" role="listitem" data-code="${s.code}" aria-label="${s.code} ${esc(s.name)} ${tag}">
      <span class="dot ${st.cls === "off" || st.cls === "fault" ? "off" : st.cls === "suspicious" ? "hollow" : ""}" style="--c:${st.cls === "suspicious" ? "var(--accent-secondary)" : c}"></span>
      <span><div class="nm">${s.code} · ${esc(s.district)}</div><div class="sub">${esc(s.name)} · ${tag}</div></span>
      <span class="val">${st.value != null ? fmt(st.value) : "—"}<small>${UNITS[S.pol]}</small></span></button>`;
  }).join("");
  $("#meshCount").textContent = `${S.sensors.filter((s) => s.status !== "offline").length}/${S.sensors.length}`;
}

// --------------------------------------------------------------- AI panel
function renderAiCard() {
  const anom = Object.values(S.latest).filter((r) => r.ai_status === "anomalous").sort((a, b) => b.anomaly_score - a.anomaly_score);
  const susp = Object.values(S.latest).filter((r) => ["suspicious", "sensor_fault"].includes(r.ai_status));
  const card = $("#aiCard"), body = $("#aiBody"), st = $("#aiStatus");
  const top = anom[0] || susp[0];
  card.classList.toggle("critical-glow", !!anom[0] && ["critical", "very_poor"].includes(anom[0].severity));
  if (!top) { st.className = "pill valid"; st.textContent = "nominal"; body.innerHTML = `<p class="muted">All active sensors within expected ranges. Monitoring ${Object.keys(S.latest).length} live streams…</p>`; return; }
  st.className = `pill ${top.ai_status}`; st.textContent = label(top.ai_status);
  const confirming = top.checks?.neighbours_confirming || [];
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:end;gap:10px">
      <div><span class="micro">Confidence</span><div class="conf" style="color:${top.confidence_score >= 80 ? "var(--accent-success)" : "var(--accent-warning)"}">${top.confidence_score}%</div></div>
      <div style="text-align:right"><span class="micro">${top.sensor_code} · ${POL_LABEL[top.checks?.lead_pollutant] || "PM2.5"}</span><div class="conf">${fmt(top[top.checks?.lead_pollutant] ?? top.pm25)}<small class="muted" style="font-size:12px"> µg/m³</small></div></div>
    </div>
    <p>${esc(top.explanation)}</p>
    ${confirming.length ? `<p class="muted" style="font-size:12px">✔ Cross-checked: ${confirming.map(esc).join(", ")}</p>` : ""}
    <p style="font-size:12px"><b style="color:var(--accent-primary)">Recommended action:</b> ${esc(top.recommended_action || "")}</p>
    <button class="btn small" data-open="${top.sensor_code}">Open ${top.sensor_code} →</button>`;
  body.querySelector("[data-open]")?.addEventListener("click", () => openSensor(top.sensor_code));
}

function timelineHtml(tl) {
  const COL = { sensor_reading: "var(--accent-primary)", ai_anomaly: "var(--accent-warning)", spatial_confirmation: "var(--accent-primary)", citizen_report: "var(--accent-secondary)",
    event_verified: "var(--accent-success)", blockchain_proof: "var(--accent-success)", alert_issued: "var(--accent-critical)", event_ended: "var(--text-muted)", dismissed: "var(--text-muted)" };
  return `<ol class="timeline">${tl.map((t, i) => `<li data-i="${i + 1}" style="--tc:${COL[t.step] || "var(--accent-primary)"}"><b>${label(t.step)}</b><span class="t">${hhmmss(t.at)}</span><div class="d">${esc(t.detail || "")}</div></li>`).join("")}</ol>`;
}

function proofHtml(e) {
  if (!e.tx_hash) return `<div class="proof" style="border-color:rgba(255,176,32,.35)"><span class="micro">Trust ledger</span><div class="row" style="margin-top:4px"><span class="k">Status</span><span style="color:var(--accent-warning)">${e.status === "verified" ? "ANCHORING…" : "AWAITING VERIFICATION"}</span></div></div>`;
  return `<div class="proof"><span class="micro">Trust ledger</span>
    <div class="row" style="margin-top:4px"><span class="k">Status</span><span style="color:var(--accent-success)">VERIFIED ✔</span></div>
    <div class="row"><span class="k">Hash</span><span title="${e.data_hash}">0x${short(e.data_hash, 12)}</span></div>
    <div class="row"><span class="k">Block</span><span>#${e.block_number}</span></div>
    <div class="row"><span class="k">Transaction</span><span title="${e.tx_hash}">${short(e.tx_hash, 12)}</span></div>
    <div class="row"><span class="k">Timestamp</span><span>${esc((e.verified_at || "").replace("T", " ").slice(0, 19))}</span></div>
    <button class="btn small" style="margin-top:8px" data-verify-event="${e.code}">Verify integrity</button></div>`;
}

function renderEventMini() {
  const live = S.events.filter((e) => !e.ended_at && e.status !== "dismissed").sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0];
  const box = $("#eventMini");
  if (!live) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `glass ai-card ${live.status === "verified" && ["critical", "very_poor"].includes(live.severity) ? "critical-glow" : ""}`;
  box.innerHTML = `<div class="hdr"><span class="micro">Environmental event · ${esc(live.code)}</span><span class="pill ${live.status}">${label(live.status)}</span></div>
    <div style="font-family:var(--font-display);font-size:16px;font-weight:600">${EVENT_ICON[live.type] || ""} ${esc(live.title)}</div>
    <div class="muted" style="font-size:12px;margin:3px 0 4px">${live.sensor_codes.length} sensors · ${live.report_codes.length} reports · <span class="pill ${live.severity}">${LEVEL_ICON[live.severity] || ""} ${label(live.severity)}</span> · ${Math.round(live.confidence_score)}%</div>
    ${timelineHtml(live.timeline.slice(-6))}
    ${proofHtml(live)}`;
}

function addFeed(item) {
  if (item.level === "trace" && S.feed.length && S.feed[0].level === "trace") S.feed.shift();
  S.feed.unshift(item);
  S.feed = S.feed.slice(0, 80);
  $("#feed").innerHTML = S.feed.map((f) => `<div class="ln ${f.level}"><time>${hhmmss(f.at)}</time>${esc(f.msg)}</div>`).join("");
}

// ----------------------------------------------------------- sensor drawer
async function openSensor(code) {
  S.selected = code;
  renderSensorList();
  const s = S.sensors.find((x) => x.code === code);
  $("#dKicker").textContent = `Sensor · ${s.profile} profile · simulated`;
  $("#dTitle").textContent = `${s.code} · ${s.name}`;
  $("#dSub").textContent = `${s.district} · ${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)} · firmware ${s.firmware_version}`;
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");
  $("#dBody").innerHTML = `<div class="processing glass card" style="height:120px"></div>`;
  map.flyTo([s.latitude, s.longitude], Math.max(map.getZoom(), 12.5), { duration: 0.8 });
  const [hist, health, fc] = await Promise.all([api(`/api/sensors/${code}/history?hours=24`), api(`/api/sensors/${code}/health`), api(`/api/forecasts/${code}`)]).catch(() => [[], null, null]);
  if (S.selected !== code) return;
  S.drawerData = { hist, health, fc };
  renderDrawer();
}

function renderDrawer() {
  const code = S.selected; if (!code || !S.drawerData) return;
  const { hist, health, fc } = S.drawerData;
  const r = S.latest[code];
  const live = S.spark[code] || [];
  const metric = (pol) => {
    const v = r?.[pol]; const lvl = v != null ? level(pol, v) : "good";
    const avg = hist.length ? hist.reduce((a, h) => a + (h[pol] || 0), 0) / hist.length : null;
    const delta = v != null && avg ? ((v - avg) / avg) * 100 : null;
    return `<div class="glass metric"><span class="micro">${POL_LABEL[pol]}</span><div class="v" style="color:${color(lvl)}">${fmt(v)}<small>${UNITS[pol]}</small></div>
      <div class="delta ${delta > 0 ? "up" : "down"}">${delta == null ? "" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)}% vs 24h avg`}</div>
      ${sparkline(live.map((x) => x[pol]).filter((x) => x != null), color(lvl))}</div>`;
  };
  const checks = r?.checks || {};
  const factors = r?.factors || [];
  $("#dBody").innerHTML = `
    <div class="grid g2" style="gap:10px">${["pm25", "pm10", "no2", "temperature"].map(metric).join("")}</div>
    ${r ? `<div class="glass card ${r.ai_status === "anomalous" && ["critical", "very_poor"].includes(r.severity) ? "critical-glow" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="micro">AI assessment · latest reading #${r.id}</span><span class="pill ${r.ai_status}">${label(r.ai_status)}</span></div>
      <p style="line-height:1.5;margin:8px 0">${esc(r.explanation)}</p>
      <div class="grid g2" style="gap:10px;margin:10px 0">
        <div><span class="micro">Confidence</span><div class="conf">${r.confidence_score}%</div></div>
        <div><span class="micro">Anomaly score</span><div class="conf" style="color:${r.anomaly_score >= 50 ? "var(--accent-critical)" : "var(--text-primary)"}">${r.anomaly_score}</div></div>
      </div>
      <div class="bars">
        ${[["Temporal (35%)", checks.temporal], ["Spatial (30%)", checks.spatial], ["Physical (20%)", checks.physical], ["Sensor health (15%)", checks.health]]
          .map(([k, v]) => `<div class="bar"><span class="muted">${k}</span><span class="track"><span class="fill" style="width:${v ?? 0}%"></span></span><span class="n">${v ?? "–"}</span></div>`).join("")}
      </div>
      <div class="mono dim" style="font-size:11px;margin-top:10px">z-score ${checks.z_score} · MA dev ${checks.ma_deviation} · isolation ${checks.isolation_score} · drift ×${checks.drift_factor} · rel ×${checks.relative_level}</div>
      ${factors.length ? `<ul class="factors" style="margin-top:10px">${factors.map((f) => `<li class="${f.impact === "+" ? "plus" : "minus"}"><b>${f.impact}</b>${esc(f.detail)}</li>`).join("")}</ul>` : ""}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn small primary" data-verify-reading="${r.id}">Verify reading on-chain</button><span class="mono dim" style="font-size:11px;align-self:center">sha256 ${short(r.data_hash, 10)}</span></div>
    </div>` : `<div class="glass card"><span class="pill maintenance">offline</span><p class="muted">No live data from this sensor.</p></div>`}
    <div class="glass card"><div style="display:flex;justify-content:space-between"><span class="micro">PM2.5 · last 24 h + forecast (1/3/6 h)</span><span class="mono dim" style="font-size:10.5px">band = 95% CI</span></div>${forecastChart(hist, fc)}
      <p class="muted" style="font-size:12px;margin:6px 0 0">${esc(fc?.explanation || "")}</p></div>
    ${health ? `<div class="glass card"><span class="micro">Sensor health</span>
      <div class="grid g3" style="gap:8px;margin-top:8px;font-size:12px">
        <div><div class="dim">Health score</div><b class="mono">${fmt(health.health_score, 0)}</b></div>
        <div><div class="dim">Battery</div><b class="mono">${fmt(health.battery_level, 0)}%</b></div>
        <div><div class="dim">Signal</div><b class="mono">${fmt(health.signal_strength, 0)} dBm</b></div>
        <div><div class="dim">Status</div><span class="pill ${health.status === "online" ? "valid" : "maintenance"}">${esc(health.status)}</span></div>
        <div><div class="dim">Calibration drift</div><b class="mono" style="color:${health.calibration.drift_factor > 1.25 ? "var(--accent-warning)" : "inherit"}">×${health.calibration.drift_factor ?? "–"}</b></div>
        <div><div class="dim">Neighbours</div><span class="mono">${health.neighbours.map((n) => n.code).join(" ")}</span></div>
      </div>
      <div class="mono dim" style="font-size:11px;margin-top:8px">Last 24h: ${health.last_24h.map((x) => `${x.ai_status} ${x.n}`).join(" · ")}</div></div>` : ""}`;
}

function forecastChart(hist, fc) {
  const W = 500, H = 170, P = 26;
  const pts = hist.map((h) => ({ t: Date.parse(h.t.length === 13 ? h.t + ":00:00Z" : h.t + ":00Z"), v: h.pm25 })).filter((p) => p.v != null);
  const now = Date.now();
  const fh = (fc?.horizons || []).filter((x) => x.metric === "pm25").map((x) => ({ t: now + x.horizon_hours * 3.6e6, v: x.predicted, lo: x.lower, hi: x.upper }));
  if (!pts.length) return `<p class="muted">No history yet.</p>`;
  const all = [...pts.map((p) => p.v), ...fh.map((f) => f.hi)];
  const tMin = pts[0].t, tMax = fh.length ? fh[fh.length - 1].t : now;
  const vMax = Math.max(40, ...all) * 1.1;
  const x = (t) => P + ((t - tMin) / (tMax - tMin)) * (W - P - 6), y = (v) => H - 18 - (v / vMax) * (H - 30);
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const fLine = [last, ...fh].map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const band = fh.length ? [`${x(last.t)},${y(last.v)}`, ...fh.map((f) => `${x(f.t)},${y(f.hi)}`), ...fh.slice().reverse().map((f) => `${x(f.t)},${y(f.lo)}`)].join(" ") : "";
  const guides = [15, 37.5, 75].filter((g) => g < vMax).map((g) => `<line x1="${P}" x2="${W - 6}" y1="${y(g)}" y2="${y(g)}" stroke="${color(level("pm25", g + 0.1))}" stroke-dasharray="3 4" opacity=".45"/><text x="${W - 8}" y="${y(g) - 3}" text-anchor="end">${g}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="PM2.5 history and forecast">
    ${guides}
    <line x1="${x(now)}" x2="${x(now)}" y1="8" y2="${H - 18}" stroke="var(--text-muted)" stroke-dasharray="2 3"/><text x="${x(now) + 3}" y="14">now</text>
    ${band ? `<polygon points="${band}" fill="var(--accent-secondary)" opacity=".18"/>` : ""}
    <polyline points="${line}" fill="none" stroke="var(--accent-primary)" stroke-width="1.8"/>
    <polyline points="${fLine}" fill="none" stroke="var(--accent-secondary)" stroke-width="1.8" stroke-dasharray="5 4"/>
    ${fh.map((f) => `<circle cx="${x(f.t)}" cy="${y(f.v)}" r="3" fill="var(--accent-secondary)"/><text x="${x(f.t)}" y="${y(f.v) - 7}" text-anchor="middle">${fmt(f.v, 0)}</text>`).join("")}
    <text x="${P}" y="${H - 4}">${new Date(tMin).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text><text x="${W - 6}" y="${H - 4}" text-anchor="end">+6h</text>
  </svg>`;
}

// ----------------------------------------------------------------- views
function showView(v) {
  $$("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  if (v === "command") setTimeout(() => map.invalidateSize(), 50);
  if (v === "command" && !S.fitted) { S.fitted = true; setTimeout(fitSensors, 60); }
  if (v === "ledger") loadLedger();
  if (v === "events") renderEvents();
  if (v === "alerts") renderAlerts();
  if (v === "citizens") { renderReports(); setTimeout(() => reportMap?.invalidateSize(), 60); }
  if (v === "simulator") loadScenarios();
  if (v === "research") renderResearch();
  if (v === "admin") loadAdmin();
  if (v === "guide") window.AT?.onGuide?.();
  S.view = v;
  window.AT?.onView?.(v);
}

function renderEvents() {
  $("#eventsGrid").innerHTML = S.events.length ? S.events.map((e) => `
    <article class="glass event-card hover ${e.status === "verified" && !e.ended_at && ["critical", "very_poor"].includes(e.severity) ? "critical-glow" : ""}">
      <div class="meta"><span class="pill ${e.status}">${label(e.status)}</span><span class="pill ${e.severity}">${LEVEL_ICON[e.severity] || ""} ${label(e.severity)}</span><span class="mono dim" style="font-size:11px">${esc(e.code)}</span>${!e.ended_at ? '<span class="live" style="padding:1px 7px"><i></i>ONGOING</span>' : ""}</div>
      <h3>${EVENT_ICON[e.type] || ""} ${esc(e.title)}</h3>
      <div class="muted" style="font-size:12px">${dt(e.started_at)} → ${e.ended_at ? dt(e.ended_at) : "now"} · confidence <b>${Math.round(e.confidence_score)}%</b> · peak PM2.5 <b>${fmt(e.peak_pm25)}</b></div>
      <p style="margin:0;font-size:13px;line-height:1.5">${esc(e.ai_explanation || e.description || "")}</p>
      <div style="font-size:12px"><span class="micro">Sensors</span> ${e.sensor_codes.map((c) => `<button class="chip" data-open="${c}">${c}</button>`).join(" ")} ${e.report_codes.length ? `<span class="micro" style="margin-left:8px">Reports</span> ${e.report_codes.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ")}` : ""}</div>
      <details><summary class="micro" style="cursor:pointer">Event timeline (${e.timeline.length})</summary>${timelineHtml(e.timeline)}</details>
      ${e.status !== "dismissed" ? proofHtml(e) : `<div class="muted" style="font-size:12px">Dismissed by AI: not corroborated above the 80% confidence threshold.</div>`}
    </article>`).join("") : `<p class="muted">No events yet.</p>`;
}

function renderAlerts() {
  const active = S.alerts.filter((a) => a.status === "active");
  $("#alBadge").hidden = !active.length; $("#alBadge").textContent = active.length;
  $("#alertsBody").innerHTML = S.alerts.slice(0, 120).map((a) => `<tr><td><span class="pill ${a.status}">${a.status}</span></td><td><span class="pill ${a.severity}">${LEVEL_ICON[a.severity] || "🛠"} ${label(a.severity)}</span></td>
    <td>${esc(a.message)}<div class="mono dim" style="font-size:10.5px">${esc(a.sensor_code)} · ${esc(a.pollutant)}</div></td><td class="muted">${esc(a.recommendation || "")}</td><td class="mono" style="font-size:11px">${dt(a.started_at)}</td><td class="mono" style="font-size:11px">${a.ended_at ? dt(a.ended_at) : "—"}</td></tr>`).join("");
}

// ---------------------------------------------------------------- citizens
let reportMap, reportPin, rType = "smoke", rLat = 41.072, rLng = 28.796;
const RTYPES = [["smoke", "☁ Smoke"], ["burning", "🔥 Burning"], ["dust", "≋ Dust"], ["industrial", "🏭 Industrial"], ["odor", "👃 Odor"], ["traffic", "🚗 Traffic"], ["heat", "🌡 Heat"]];
function initReportForm() {
  $("#typeChips").innerHTML = RTYPES.map(([k, l]) => `<button type="button" role="radio" aria-checked="${k === rType}" class="${k === rType ? "on" : ""}" data-type="${k}">${l}</button>`).join("");
  $("#typeChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; rType = b.dataset.type; $$("#typeChips button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); }); });
  reportMap = L.map("reportMap", { attributionControl: false }).setView([rLat, rLng], 12);
  addBasemap(reportMap);
  for (const s of S.sensors) L.circleMarker([s.latitude, s.longitude], { radius: 4, color: "#00e5ff", weight: 1, fillOpacity: 0.6 }).addTo(reportMap).bindTooltip(s.code);
  reportPin = L.marker([rLat, rLng], { draggable: true }).addTo(reportMap);
  const setLoc = (ll) => { rLat = ll.lat; rLng = ll.lng; reportPin.setLatLng(ll); $("#rLoc").value = `${rLat.toFixed(4)}, ${rLng.toFixed(4)}`; };
  reportMap.on("click", (e) => setLoc(e.latlng));
  reportPin.on("dragend", () => setLoc(reportPin.getLatLng()));
  $("#reportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; btn.textContent = "Correlating with sensors…";
    $("#reportResult").innerHTML = `<div class="processing glass card" style="height:60px"></div>`;
    try {
      const r = await api("/api/reports", { method: "POST", body: { type: rType, latitude: rLat, longitude: rLng, severity: $("#rSeverity").value, description: $("#rDesc").value } });
      upsert(S.reports, r, "code"); renderReports(); renderReportsOnMap();
      $("#reportResult").innerHTML = reportCard(r, true);
      toast(`Report ${r.code} received`, `AI correlation ${r.ai_correlation_score}/100 (${label(r.correlation_status)})`, r.ai_correlation_score >= 60 ? "success" : "info");
    } catch (err) { $("#reportResult").innerHTML = `<p style="color:var(--accent-danger)">${esc(err.message)}</p>`; }
    btn.disabled = false; btn.textContent = "Send report →";
  });
}

function reportCard(r, detailed = false) {
  const parts = r.correlation_parts ? Object.entries(r.correlation_parts) : [];
  return `<div class="glass card" style="padding:12px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${esc(r.code)} · ${esc(r.type)}</b><span class="pill ${r.correlation_status}">${label(r.correlation_status)}</span></div>
    <div class="muted" style="font-size:12px;margin:3px 0">${dt(r.created_at)} · ${fmt(r.latitude, 3)}, ${fmt(r.longitude, 3)} · ${esc(r.severity)}${r.event_id ? ` · linked to event` : ""}</div>
    ${r.description ? `<div style="font-size:12.5px;margin:4px 0">“${esc(r.description)}”</div>` : ""}
    <div class="score"><span class="track"><span class="fill" style="width:${r.ai_correlation_score ?? 0}%"></span></span><span class="mono">${r.ai_correlation_score ?? "…"}/100</span></div>
    <div class="muted" style="font-size:11.5px;margin-top:4px">${esc(r.correlation_explanation || "")}</div>
    ${detailed && parts.length ? `<div class="bars" style="margin-top:8px">${parts.map(([k, v]) => `<div class="bar"><span class="muted">${label(k)}</span><span class="track"><span class="fill" style="width:${(v / { distance: 25, time: 15, pollutant_increase: 30, wind: 10, neighbour_confirmation: 10, severity_alignment: 10 }[k]) * 100}%"></span></span><span class="n">${v.toFixed(0)}</span></div>`).join("")}</div>` : ""}
  </div>`;
}
function renderReports() { $("#reportFeed").innerHTML = S.reports.slice(0, 25).map((r) => reportCard(r)).join(""); }

// ------------------------------------------------------------------ ledger
async function loadLedger() {
  const d = await api("/api/blockchain/proofs");
  S.ledger = d.ledger;
  const st = await api("/api/stats");
  const L_ = d.ledger;
  $("#ledgerKpis").innerHTML = [
    ["Merkle batches", L_.totals?.batches ?? "–"], ["Event proofs", L_.totals?.events ?? "–"], ["Critical reading proofs", L_.totals?.readings ?? "–"],
    ["Readings covered", `${((st.anchored_readings / Math.max(1, st.total_readings)) * 100).toFixed(1)}%`],
  ].map(([k, v]) => `<div class="glass metric"><span class="micro">${k}</span><div class="v">${v}</div></div>`).join("");
  $("#ledgerInfo").innerHTML = L_.connected ? `<div class="grid g4" style="font-size:12.5px">
      <div><span class="micro">Network</span><div class="mono">${esc(L_.network.name)} · chain ${L_.network.chainId}</div></div>
      <div><span class="micro">Contract</span><div class="hash">${esc(L_.contract)}</div></div>
      <div><span class="micro">Latest block</span><div class="mono">#${L_.block}</div></div>
      <div><span class="micro">Hashing</span><div class="mono">SHA-256 · sorted-pair Merkle</div></div></div>`
    : `<span class="pill failed">ledger offline</span> <span class="muted">${esc(L_.error || "")}</span>`;
  $("#evProofs").innerHTML = d.events.map((e) => `<tr><td>${EVENT_ICON[e.type] || ""} ${esc(e.code)}<div class="dim" style="font-size:11px">${esc(e.title)}</div></td><td class="hash" title="${e.data_hash}">0x${short(e.data_hash, 8)}</td><td class="mono">#${e.block_number}</td><td><button class="btn small" data-verify-event="${e.code}">Verify</button></td></tr>`).join("");
  $("#rdProofs").innerHTML = d.readings.map((r) => `<tr><td class="mono">#${r.id}<div class="dim" style="font-size:11px">${esc(r.sensor_code)} · ${dt(r.captured_at)}</div></td><td class="mono">${fmt(r.pm25)}</td><td class="mono">#${r.block_number}</td><td><button class="btn small" data-verify-reading="${r.id}">Verify</button></td></tr>`).join("");
  $("#batches").innerHTML = d.batches.map((b) => `<tr><td class="mono">${b.id}</td><td class="hash" title="${b.merkle_root}">0x${short(b.merkle_root, 14)}</td><td class="mono">${b.reading_count}</td><td class="mono" style="font-size:11px">${dt(b.from_time)} → ${hhmmss(b.to_time)}</td><td class="mono">#${b.block_number}</td><td class="hash" title="${b.tx_hash}">${short(b.tx_hash, 8)}</td></tr>`).join("");
}

// ------------------------------------------------------------------ verify
async function runVerify(kind, id) {
  showView("verify");
  $("#vKind").value = kind; $("#vId").value = id;
  $("#vVerdict").innerHTML = `<div class="verdict pend processing">Recomputing SHA-256 and querying the smart contract…</div>`;
  $("#vSteps").innerHTML = "";
  try {
    const v = await api(`/api/verify/${kind}/${encodeURIComponent(id)}`);
    S.lastVerify = v;
    await new Promise((r) => setTimeout(r, 450));
    $("#vSteps").innerHTML = (v.steps || []).map((s) => `<li class="${s.ok ? "ok" : "bad"}"><span class="ic">${s.ok ? "✓" : "✕"}</span><div><b>${esc(s.step)}</b><div class="d">${esc(s.detail)}</div></div></li>`).join("");
    const lis = $$("#vSteps li");
    for (let i = 0; i < lis.length; i++) { await new Promise((r) => setTimeout(r, 260)); lis[i].classList.add("show"); }
    const cls = v.status === "verified" ? "ok" : v.status === "failed" ? "bad" : "pend";
    $("#vVerdict").innerHTML = `<div class="verdict ${cls}">${v.status === "verified" ? "✔ Data integrity verified" : v.status === "failed" ? "✕ Integrity check failed" : "◷ Pending"}<small>${esc(v.message)}</small></div>`;
    if (v.status === "failed") toast("Integrity check failed", "Stored data no longer matches the on-chain proof", "critical");
    const rec = v.record ? `<table class="t" style="margin:4px 0 10px"><tbody>${Object.entries(v.record).map(([k, val]) => `<tr><td class="dim">${esc(k)}</td><td class="mono" style="${S.tamper && S.tamper.kind === kind && String(S.tamper.id) === String(id) && k === "pm25" ? "color:var(--accent-critical)" : ""}">${esc(val)}</td></tr>`).join("")}</tbody></table>` : "";
    $("#vEvidence").innerHTML = `${rec}
      <div class="cmp"><span class="micro">Recomputed hash (from stored data)</span><div class="hash ${v.status === "failed" ? "bad" : ""}">0x${esc(v.recomputed_hash || "")}</div>
      <span class="micro" style="margin-top:6px">Hash anchored at write time</span><div class="hash">0x${esc(v.stored_hash || "")}</div></div>
      ${v.batch ? `<div class="proof" style="margin-top:10px"><span class="micro">Merkle batch</span><div class="row"><span class="k">Root</span><span>0x${short(v.batch.merkle_root, 14)}</span></div><div class="row"><span class="k">Readings</span><span>${v.batch.reading_count}</span></div><div class="row"><span class="k">Block</span><span>#${v.batch.block_number}</span></div><div class="row"><span class="k">Tx</span><span>${short(v.batch.tx_hash, 14)}</span></div></div>` : ""}
      ${v.tx_hash ? `<div class="proof" style="margin-top:10px"><span class="micro">Event proof</span><div class="row"><span class="k">Block</span><span>#${v.block_number}</span></div><div class="row"><span class="k">Tx</span><span>${short(v.tx_hash, 14)}</span></div></div>` : ""}
      <details style="margin-top:10px"><summary class="micro" style="cursor:pointer">Canonical payload hashed</summary><pre class="code">${esc(v.canonical_payload || "")}</pre></details>`;
    $("#tamperBtn").disabled = v.status !== "verified" || !S.user || S.user.role !== "admin";
    $("#tamperBtn").title = !S.user || S.user.role !== "admin" ? "Sign in as admin to run the demo" : "";
  } catch (e) { $("#vVerdict").innerHTML = `<div class="verdict bad">${esc(e.message)}</div>`; }
}

// --------------------------------------------------------------- scenarios
async function loadScenarios() {
  const list = await api("/api/scenarios");
  $("#scenarioGrid").innerHTML = list.map((s) => `<div class="glass scenario hover ${s.status === "running" ? "running" : ""}">
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="micro">${esc(label(s.type))}${s.center ? " · " + esc(s.center) : ""}</span>${s.status === "running" ? '<span class="live" style="padding:1px 7px"><i></i>RUNNING</span>' : `<span class="mono dim" style="font-size:11px">${s.duration_minutes ? s.duration_minutes + " min" : "instant"}</span>`}</div>
    <h3>${esc(s.name)}</h3><p>${esc(s.description)}</p>
    <button class="btn ${s.id === "burning" ? "primary" : ""}" data-trigger="${s.id}">Trigger →</button></div>`).join("");
}

async function trigger(id) {
  if (!S.user || !["operator", "admin"].includes(S.user.role)) { openLogin("operator@airtrust.demo", () => trigger(id)); return; }
  try {
    await api(`/api/scenarios/${id}/trigger`, { method: "POST" });
    toast("Scenario triggered", id === "burning" ? "Watch AT-007 (İkitelli) on the command center" : label(id), "info");
    loadScenarios();
    if (!["normal", "recovery"].includes(id)) setTimeout(() => showView("command"), 600);
  } catch (e) { toast("Could not trigger", e.message, "warning"); }
}

// ---------------------------------------------------------------- research
function renderResearch() {
  const o = location.origin;
  $("#curlBox").textContent = `# Live KPIs
curl ${o}/api/stats

# Latest anomalous readings, highest anomaly score first
curl "${o}/api/readings?status=anomalous&sort=anomaly_score&limit=5"

# 1/3/6-hour forecast for a sensor
curl ${o}/api/forecasts/AT-007

# Verify a reading independently (recomputes SHA-256 + on-chain Merkle check)
curl ${o}/api/verify/reading/1

# Submit a citizen report (anonymous)
curl -X POST ${o}/api/reports -H "Content-Type: application/json" \\
  -d '{"type":"smoke","latitude":41.072,"longitude":28.796,"severity":"high"}'

# Ingest a reading from a real device gateway
curl -X POST ${o}/api/readings -H "X-Device-Key: demo-device-key" -H "Content-Type: application/json" \\
  -d '{"sensor_id":"AT-001","timestamp":"${new Date().toISOString()}","pm25":18.4,"pm10":32.1,"no2":21.7,"o3":34.2,"temperature":24.6,"humidity":68.2,"wind_speed":2.4,"wind_direction":180}'

# Research export: 30 days, AI-trusted readings only
curl -o airtrust.csv "${o}/api/export/readings.csv?days=30&official=true"`;
}

// ------------------------------------------------------------------- admin
async function loadAdmin() {
  const box = $("#adminBody");
  if (!S.user || S.user.role !== "admin") { box.innerHTML = `<div class="glass card"><p class="muted">Admin session required.</p><button class="btn primary" id="adminLogin">Sign in as admin</button></div>`; $("#adminLogin").onclick = () => openLogin("admin@airtrust.demo", loadAdmin); return; }
  const d = await api("/api/admin/overview");
  box.innerHTML = `
    <div class="grid g3">
      <div class="glass metric"><span class="micro">Readings stored</span><div class="v">${d.health.readings.toLocaleString()}</div></div>
      <div class="glass metric"><span class="micro">AI latency / reading</span><div class="v">${fmt(d.health.ai_latency_ms, 2)}<small>ms</small></div></div>
      <div class="glass metric"><span class="micro">Ledger</span><div class="v" style="font-size:18px">${d.health.ledger.connected ? "Connected · #" + d.health.ledger.block : "Offline"}</div></div>
    </div>
    <div class="glass card tablewrap"><span class="micro">Sensors</span><table class="t"><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Health</th><th>Battery</th><th>Firmware</th><th>Last seen</th></tr></thead><tbody>
      ${S.sensors.map((s) => `<tr><td class="mono">${s.code}</td><td>${esc(s.name)}</td><td><span class="pill ${s.status === "online" ? "valid" : "maintenance"}">${esc(s.status)}</span></td><td class="mono">${fmt(s.health_score, 0)}</td><td class="mono">${fmt(s.battery_level, 0)}%</td><td class="mono">${esc(s.firmware_version)}</td><td class="mono" style="font-size:11px">${dt(s.last_seen_at)}</td></tr>`).join("")}</tbody></table></div>
    <div class="grid g2">
      <div class="glass card tablewrap"><span class="micro">Thresholds (configurable, WHO 2021 derived)</span><table class="t"><thead><tr><th>Pollutant</th><th>Good ≤</th><th>Moderate ≤</th><th>Poor ≤</th><th>Very poor ≤</th></tr></thead><tbody>
        ${Object.entries(d.thresholds).map(([p, l]) => `<tr><td>${POL_LABEL[p] || p}</td>${l.slice(0, 4).map((x) => `<td class="mono">${x.max}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="glass card tablewrap"><span class="micro">Users &amp; roles</span><table class="t"><thead><tr><th>Email</th><th>Role</th></tr></thead><tbody>${d.users.map((u) => `<tr><td>${esc(u.email)}</td><td><span class="pill valid">${esc(u.role)}</span></td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="glass card tablewrap"><span class="micro">Audit log</span><table class="t"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
      ${d.audit_logs.map((a) => `<tr><td class="mono" style="font-size:11px">${dt(a.created_at)}</td><td class="mono">${a.user_id ?? "anon"}</td><td>${esc(a.action)}</td><td class="mono">${esc(a.entity)} ${esc(a.entity_id)}</td><td class="mono dim" style="font-size:11px">${esc(a.metadata)}</td></tr>`).join("")}</tbody></table></div>`;
}

// -------------------------------------------------------------------- auth
const DEMO = [["admin@airtrust.demo", "Admin", "all features + tamper demo"], ["operator@airtrust.demo", "Operator", "trigger scenarios, anchor proofs"], ["researcher@airtrust.demo", "Researcher", "data export"], ["citizen@airtrust.demo", "Citizen", "submit reports"]];
function openLogin(prefill = "operator@airtrust.demo", then) {
  $("#mBox").innerHTML = `<h2 id="mTitle" style="font-family:var(--font-display);margin:0 0 4px">Sign in</h2><p class="muted" style="margin:0 0 14px;font-size:12.5px">Demo accounts · password <span class="mono">AirTrust2026!</span></p>
    <form id="loginForm" class="grid" style="gap:10px"><label class="f">Email<input id="lEmail" value="${esc(prefill)}" autocomplete="username"></label><label class="f">Password<input id="lPass" type="password" value="AirTrust2026!" autocomplete="current-password"></label>
    <button class="btn primary" type="submit">Sign in</button><div id="lErr" style="color:var(--accent-danger);font-size:12px"></div></form>
    <div class="grid g2" style="gap:6px;margin-top:12px">${DEMO.map(([e, r, d]) => `<button class="btn small" data-demo="${e}" style="flex-direction:column;align-items:flex-start"><b>${r}</b><span class="dim" style="font-size:10.5px">${d}</span></button>`).join("")}</div>
    <button class="btn small" id="mClose" style="margin-top:12px">Cancel</button>`;
  $("#modal").classList.add("open");
  $("#lEmail").focus();
  const doLogin = async (email) => {
    try {
      const d = await api("/api/auth/login", { method: "POST", body: { email, password: $("#lPass").value } });
      S.token = d.token; S.user = d.user;
      try { sessionStorage.setItem("airtrust_session", JSON.stringify(d)); } catch {}
      $("#modal").classList.remove("open"); renderUser(); toast(`Signed in as ${d.user.role}`, d.user.email, "success");
      then && then();
    } catch (e) { $("#lErr").textContent = e.message; }
  };
  $("#loginForm").onsubmit = (e) => { e.preventDefault(); doLogin($("#lEmail").value); };
  $$("[data-demo]", $("#mBox")).forEach((b) => (b.onclick = () => { $("#lEmail").value = b.dataset.demo; doLogin(b.dataset.demo); }));
  $("#mClose").onclick = () => $("#modal").classList.remove("open");
}
function renderUser() {
  const b = $("#userBtn");
  b.textContent = S.user ? `${S.user.role} · sign out` : "Sign in";
  b.onclick = S.user ? () => { S.user = null; S.token = null; try { sessionStorage.removeItem("airtrust_session"); } catch {} renderUser(); } : () => openLogin();
}

// ------------------------------------------------------------ palette (⌘K)
function openPalette() {
  const items = [
    ...["command", "events", "alerts", "citizens", "ledger", "verify", "simulator", "research", "admin"].map((v) => ({ t: `Go to ${label(v)}`, k: "view", run: () => showView(v) })),
    ...S.sensors.map((s) => ({ t: `Open sensor ${s.code} · ${s.name}`, k: "sensor", run: () => { showView("command"); openSensor(s.code); } })),
    ...["burning", "industrial", "dust", "rush_hour", "heatwave", "sensor_fault", "drift", "spike", "recovery", "normal"].map((id) => ({ t: `Trigger scenario: ${label(id)}`, k: "scenario", run: () => trigger(id) })),
    { t: "Verify latest verified event", k: "verify", run: () => { const e = S.events.find((x) => x.tx_hash); if (e) runVerify("event", e.code); } },
  ];
  const pal = $("#palette"); pal.classList.add("open");
  const inp = $("#pInput"); inp.value = ""; inp.focus();
  let sel = 0, shown = items;
  const draw = () => { $("#pList").innerHTML = shown.slice(0, 12).map((it, i) => `<li class="${i === sel ? "sel" : ""}" data-i="${i}"><span>${esc(it.t)}</span><kbd>${it.k}</kbd></li>`).join(""); };
  const run = (i) => { pal.classList.remove("open"); shown[i]?.run(); };
  inp.oninput = () => { const q = inp.value.toLowerCase(); shown = items.filter((it) => it.t.toLowerCase().includes(q)); sel = 0; draw(); };
  inp.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); } else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); } else if (e.key === "Enter") run(sel); else if (e.key === "Escape") pal.classList.remove("open"); };
  $("#pList").onclick = (e) => { const li = e.target.closest("li"); if (li) run(+li.dataset.i); };
  pal.onclick = (e) => { if (e.target === pal) pal.classList.remove("open"); };
  draw();
}

function updateEvBadge() { const n = S.events.filter((e) => !e.ended_at && e.status !== "dismissed").length; $("#evBadge").hidden = !n; $("#evBadge").textContent = n; }

// -------------------------------------------------------------- live data
function upsert(arr, item, key = "id") { const i = arr.findIndex((x) => x[key] === item[key]); if (i >= 0) arr[i] = { ...arr[i], ...item }; else arr.unshift(item); }

function onReadings(rs) {
  for (const r of rs) {
    S.latest[r.sensor_code] = r;
    const s = S.sensors.find((x) => x.code === r.sensor_code);
    if (s) { s.status = r.ai_status === "sensor_fault" ? "fault" : (r.checks?.drift_factor > 1.25 ? "maintenance" : "online"); s.last_seen_at = r.captured_at; }
    (S.spark[r.sensor_code] = S.spark[r.sensor_code] || []).push(r);
    if (S.spark[r.sensor_code].length > 60) S.spark[r.sensor_code].shift();
  }
  refreshLive();
  if (S.selected && rs.some((r) => r.sensor_code === S.selected) && $("#drawer").classList.contains("open")) renderDrawer();
  S.rpmCount = (S.rpmCount || 0) + rs.length;
}

let tickerItems = [];
function refreshLive() {
  for (const s of S.sensors) renderMarker(s.code);
  renderSensorList(); renderAiCard();
  const vals = Object.values(S.latest).filter((r) => r.ai_status !== "sensor_fault");
  tickerItems = vals.map((r) => `${r.sensor_code} PM2.5 ${fmt(r.pm25)} · NO₂ ${fmt(r.no2, 0)} · ${fmt(r.temperature)}°C · ${label(r.ai_status)} ${r.confidence_score}%`);
}

async function refreshStats() {
  try {
    const st = await api("/api/stats");
    countUp($("#kOnline"), st.sensors_online); $("#kOnline").textContent = `${st.sensors_online}`; $("#kOnline").insertAdjacentHTML("beforeend", `<small class="dim" style="font-size:12px">/${st.sensors_total}</small>`);
    countUp($("#kRpm"), st.readings_per_minute); countUp($("#kAnom"), st.active_anomalies); countUp($("#kEvents"), st.verified_events);
    $("#tAi").textContent = `${st.ai_latency_ms} ms/reading`;
    $("#aiLatency").textContent = `${st.ai_latency_ms} ms · ${st.readings_per_minute}/min`;
    $("#tAnch").textContent = `${st.anchored_readings.toLocaleString()} / ${st.total_readings.toLocaleString()}`;
    const h = await api("/api/health");
    $("#tLedger").textContent = h.ledger.connected ? `${h.ledger.network.name} #${h.ledger.block}` : "offline";
    $("#tLedger").style.color = h.ledger.connected ? "var(--accent-success)" : "var(--accent-danger)";
  } catch {}
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { $("#livePill").classList.remove("off"); $("#livePill span").textContent = "LIVE"; $("#tSys").textContent = "● NOMINAL"; $("#tSys").style.color = "var(--accent-success)"; };
  ws.onclose = () => { $("#livePill").classList.add("off"); $("#livePill span").textContent = "RECONNECTING"; $("#tSys").textContent = "● LINK LOST"; $("#tSys").style.color = "var(--accent-danger)"; setTimeout(connectWs, 2000); };
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === "readings") onReadings(data);
    else if (type === "ai") addFeed(data);
    else if (type === "event") {
      const prev = S.events.find((e) => e.code === data.code);
      upsert(S.events, data, "code");
      if (!prev) toast("Environmental event detected", data.title, "warning");
      else if (prev.status !== "verified" && data.status === "verified") toast("Event verified", `${data.title} · ${Math.round(data.confidence_score)}%`, "critical");
      renderEventMini(); renderEventsOnMap(); if (S.view === "events") renderEvents();
      updateEvBadge();
    } else if (type === "alert") { upsert(S.alerts, data, "id"); renderAlerts(); if (data.status === "active" && ["critical", "very_poor"].includes(data.severity)) toast("Critical alert issued", data.message, "critical"); }
    else if (type === "proof") { if (data.kind === "event") toast("Proof anchored on-chain", `${data.code} · block #${data.blockNumber}`, "success"); if (S.view === "ledger") loadLedger(); }
    else if (type === "report") { upsert(S.reports, data, "code"); renderReportsOnMap(); if (S.view === "citizens") renderReports(); }
    else if (type === "scenarios" && S.view === "simulator") loadScenarios();
  };
}

// -------------------------------------------------------------------- init
async function init() {
  initMap();
  const [sensors, events, alerts, reports] = await Promise.all([api("/api/sensors"), api("/api/events"), api("/api/alerts"), api("/api/reports")]);
  S.sensors = sensors; S.events = events; S.alerts = alerts; S.reports = reports;
  for (const s of sensors) if (s.latest && Date.now() - Date.parse(s.latest.captured_at) < 120_000) {
    const ex = s.latest.ai_explanation || {};
    S.latest[s.code] = { ...s.latest, explanation: ex.explanation, checks: ex.checks, factors: ex.factors, recommended_action: ex.recommended_action, severity: ex.severity };
  }
  fitSensors(); refreshLive(); renderReportsOnMap(); renderEventsOnMap(); renderEventMini(); renderAlerts(); renderUser(); initReportForm();
  updateEvBadge();
  connectWs(); refreshStats(); setInterval(refreshStats, 5000);
  setInterval(() => { $("#tClock").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Istanbul" }) + " TRT"; }, 1000);
  setInterval(() => { if (tickerItems.length) $("#ticker").textContent = tickerItems.join("   ◆   "); }, 6000);

  // events
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("#sensorList").addEventListener("click", (e) => { const r = e.target.closest(".sensor-row"); if (r) openSensor(r.dataset.code); });
  $$(".filters .chip").forEach((c) => c.addEventListener("click", () => {
    S.pol = c.dataset.pol; $$(".filters .chip").forEach((x) => x.classList.toggle("on", x === c));
    $("#mapTitle").textContent = `Istanbul · ${POL_LABEL[S.pol]} ${UNITS[S.pol]}`; refreshLive();
  }));
  $$(".layers input").forEach((i) => i.addEventListener("change", () => { S.layers[i.dataset.layer] = i.checked; refreshLive(); renderReportsOnMap(); renderEventsOnMap(); }));
  $("#dClose").onclick = () => { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); S.selected = null; renderSensorList(); };
  document.addEventListener("click", (e) => {
    const vr = e.target.closest("[data-verify-reading]"); if (vr) return runVerify("reading", vr.dataset.verifyReading);
    const ve = e.target.closest("[data-verify-event]"); if (ve) return runVerify("event", ve.dataset.verifyEvent);
    const tr = e.target.closest("[data-trigger]"); if (tr) return trigger(tr.dataset.trigger);
    const op = e.target.closest("[data-open]"); if (op && op.closest("#eventsGrid")) { showView("command"); openSensor(op.dataset.open); }
  });
  $("#vBtn").onclick = () => runVerify($("#vKind").value, $("#vId").value.trim());
  $("#vId").onkeydown = (e) => { if (e.key === "Enter") $("#vBtn").click(); };
  $("#vLatest").onclick = async () => { const d = await api("/api/readings?status=anomalous&anchored=true&limit=1"); if (d.data[0]) runVerify("reading", d.data[0].id); else toast("No anomalous reading yet", "Trigger a scenario first", "info"); };
  $("#vLatestEvent").onclick = () => { const e = S.events.find((x) => x.tx_hash); if (e) runVerify("event", e.code); };
  $("#tamperBtn").onclick = async () => {
    if (!S.user || S.user.role !== "admin") return openLogin("admin@airtrust.demo");
    const v = S.lastVerify; if (!v) return;
    const body = v.kind === "reading" ? { reading_id: v.id } : { event_id: v.code };
    const d = await api("/api/demo/tamper", { method: "POST", body });
    S.tamper = { kind: v.kind, id: v.kind === "reading" ? v.id : v.code, original: d.original };
    toast("Record tampered in the database", `${d.field}: ${d.original} → ${d.tampered}`, "warning");
    $("#restoreBtn").disabled = false;
    runVerify(v.kind, S.tamper.id);
  };
  $("#restoreBtn").onclick = async () => {
    const t = S.tamper; if (!t) return;
    await api("/api/demo/tamper", { method: "POST", body: t.kind === "reading" ? { reading_id: t.id, restore: true, original: t.original } : { event_id: t.id, restore: true, original: t.original } });
    S.tamper = null; $("#restoreBtn").disabled = true; toast("Original value restored", "", "success"); runVerify(t.kind, t.kind === "reading" ? t.id : t.id);
  };
  $("#themeBtn").onclick = () => { const light = document.documentElement.dataset.theme !== "light"; document.documentElement.dataset.theme = light ? "light" : ""; try { localStorage.setItem("airtrust_theme", light ? "light" : "dark"); } catch {} };
  $("#paletteBtn").onclick = openPalette;
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") { $("#modal").classList.remove("open"); $("#palette").classList.remove("open"); if ($("#drawer").classList.contains("open")) $("#dClose").click(); }
  });
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.remove("open"); });
}

async function loginAs(email) {
  if (S.user && S.user.email === email) return S.user;
  const d = await api("/api/auth/login", { method: "POST", body: { email, password: "AirTrust2026!" } });
  S.token = d.token; S.user = d.user;
  try { sessionStorage.setItem("airtrust_session", JSON.stringify(d)); } catch {}
  renderUser();
  return d.user;
}

window.AT = Object.assign(window.AT || {}, { S, api, fitSensors, esc, toast, showView, openSensor, runVerify, trigger, openLogin, loginAs, upsert, renderReports, renderReportsOnMap, label, fmt });

boot();
init().catch((e) => { console.error(e); toast("Could not reach the AirTrust API", e.message, "critical"); });
})();
