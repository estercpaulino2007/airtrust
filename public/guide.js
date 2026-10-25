/* AirTrust onboarding: "How it works" page, welcome dialog, guided demo and the embedded AI assistant. */
(() => {
"use strict";
const AT = window.AT;
const $ = (s, el = document) => el.querySelector(s);
const esc = AT.esc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================== HOW IT WORKS
const PIPELINE = [
  ["📡", "Sense", "12 low-cost sensors across Istanbul, on both sides of the Bosphorus, send PM2.5, PM10, NO₂, O₃, temperature, humidity and wind every 5 seconds. Residents report what they see or smell."],
  ["🧠", "Understand", "An explainable AI checks every reading: is it physically possible? unusual for this hour? do neighbouring sensors agree? is the sensor frozen or drifting? It gives each reading an anomaly score and a confidence score."],
  ["🔗", "Confirm", "When several sensors and citizen reports agree, the AI opens an environmental event (smoke, dust, industrial, traffic, heatwave) and verifies it at ≥ 80% confidence."],
  ["🔒", "Seal", "The evidence gets a SHA-256 fingerprint stored on a blockchain. Nobody, not even the database admin, can change it later without being caught."],
  ["📢", "Act & verify", "A public alert with recommendations is issued, and anyone can open the Verify tab to check that a record is authentic."],
];
const TABS = [
  ["command", "🛰", "Command Center", "The live map. Each dot is a sensor colored by risk (green → red). Click one for details, AI explanation and a 6-hour forecast. The right side shows what the AI is thinking right now."],
  ["events", "🔥", "Events", "Pollution episodes the AI confirmed (or dismissed as not trustworthy), with the full timeline and the blockchain proof."],
  ["alerts", "🚨", "Alerts", "Public-health alerts and maintenance alerts (frozen sensor, calibration drift, offline device)."],
  ["citizens", "🙋", "Citizen Signals", "Report smoke, dust, odor, traffic or heat by clicking the map. The AI tells you how well your report matches nearby sensors (0–100)."],
  ["ledger", "⛓", "Trust Ledger", "Everything sealed on the blockchain: batches of readings, event proofs and critical reading proofs."],
  ["verify", "✅", "Verify", "Paste a reading id or event code and the portal checks it against the blockchain. Admins can tamper with a record to see verification fail."],
  ["simulator", "🧪", "Scenario Simulator", "Start a fire, industrial smoke, a dust storm, a heatwave or a broken sensor and watch the AI react. Requires operator or admin."],
  ["research", "📊", "Research API", "Open API with interactive docs and CSV/JSON downloads for researchers."],
  ["admin", "⚙️", "Admin", "Sensors, users, thresholds, system health and the audit log."],
];
const GLOSSARY = [
  ["PM2.5", "Fine particles (smoke, combustion) that reach deep into the lungs. WHO 24 h guideline: 15 µg/m³."],
  ["PM10", "Coarser inhalable particles (dust, construction). WHO 24 h guideline: 45 µg/m³."],
  ["NO₂ / O₃", "Nitrogen dioxide (traffic, combustion) and ground-level ozone (forms with sunlight)."],
  ["Anomaly score", "How unusual the air is right now compared with this sensor's history and its neighbours (0–100)."],
  ["Confidence score", "How much we trust the measurement: 35% consistency over time + 30% agreement with neighbours + 20% physically valid + 15% sensor health."],
  ["Held for review", "Unusual but not confirmed by any neighbour: probably a glitch, kept out of official averages."],
  ["Calibration drift", "A sensor slowly starts reading too high or too low. Detected by comparing it with its neighbours over time."],
  ["Merkle batch", "Hundreds of readings combined into one fingerprint and one blockchain transaction; each reading stays individually provable."],
];

function renderGuide() {
  const page = $("#guidePage");
  if (page.dataset.done) return;
  page.dataset.done = "1";
  page.innerHTML = `
    <div class="hero glass">
      <div>
        <span class="micro">Climate Intelligence OS · Istanbul pilot · simulated data</span>
        <h1 style="font-size:34px;margin:8px 0 10px">Air-quality data you can <span class="grad">trust</span>.</h1>
        <p class="lead" style="margin-bottom:16px">Cheap sensors can cover a whole city, but their data is often doubted: they drift, freeze, glitch, and records can be altered. <b>AirTrust</b> checks every reading with explainable AI, confirms pollution events with neighbouring sensors and citizens, and seals the evidence on a blockchain so anyone can verify it.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" data-start-tour>▶ Start the 2-minute guided demo</button>
          <button class="btn" data-goto="command">Open the live map →</button>
          <button class="btn" data-ask="What does each tab do?">✦ Ask the AI</button>
        </div>
      </div>
      <div class="who">
        <span class="micro">Who it's for</span>
        <ul>
          <li><b>Residents & schools</b>: is the air safe right now in my area?</li>
          <li><b>City agencies</b>: trusted alerts and sensor maintenance</li>
          <li><b>Researchers & journalists</b>: open data with proof of integrity</li>
          <li><b>NGOs</b>: community monitoring that can't be dismissed</li>
        </ul>
      </div>
    </div>

    <h2 class="sec">How it works, in 5 steps</h2>
    <div class="pipeline">${PIPELINE.map(([i, t, d], k) => `<div class="glass step"><div class="n">${k + 1}</div><div class="ic" aria-hidden="true">${i}</div><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>

    <h2 class="sec">What each tab does</h2>
    <div class="grid g3">${TABS.map(([v, i, t, d]) => `<button class="glass card hover tabcard" data-goto="${v}"><span class="ic" aria-hidden="true">${i}</span><h3>${t}</h3><p>${d}</p><span class="go">Open →</span></button>`).join("")}</div>

    <h2 class="sec">Reading the map</h2>
    <div class="grid g2">
      <div class="glass card">
        <div class="legend-rows">
          ${[["var(--risk-good)", "▾ Good", "PM2.5 ≤ 15 µg/m³ · normal activity"], ["var(--risk-moderate)", "◆ Moderate", "≤ 25 · sensitive people take care"], ["var(--risk-poor)", "▲ Poor", "≤ 37.5 · sensitive groups reduce exertion"], ["var(--risk-very_poor)", "▲▲ Very poor", "≤ 75 · everyone reduce exertion"], ["var(--risk-critical)", "⚠ Critical", "> 75 · avoid outdoor activity"]]
            .map(([c, l, d]) => `<div><span class="dot" style="--c:${c}"></span><b>${l}</b><span class="muted">${d}</span></div>`).join("")}
          <div><span class="dot hollow" style="--c:var(--accent-secondary)"></span><b>Held for review</b><span class="muted">unusual, not confirmed by neighbours</span></div>
          <div><span class="dot off"></span><b>Offline / fault</b><span class="muted">no data, or frozen sensor</span></div>
        </div>
      </div>
      <div class="glass card" style="font-size:13px;line-height:1.6">
        <p style="margin-top:0"><b>Pulsing rings</b> pulse faster when the anomaly is stronger. <b>Glowing halos</b> show pollution intensity. <b>Small cyan arrows</b> show where the wind is blowing the air. <b>Dashed circles</b> are environmental events (amber = being checked, red = verified). <b>Purple pins</b> are citizen reports.</p>
        <p style="margin-bottom:0">Colors are always paired with a symbol and a text label, so risk is readable without color.</p>
      </div>
    </div>

    <h2 class="sec">Glossary</h2>
    <div class="grid g2">${GLOSSARY.map(([t, d]) => `<div class="glass card" style="padding:12px 14px"><b>${t}</b><div class="muted" style="font-size:12.5px;margin-top:3px">${d}</div></div>`).join("")}</div>

    <h2 class="sec">Demo accounts</h2>
    <div class="glass card" style="font-size:13px">Password for all: <span class="mono">AirTrust2026!</span> · <b>admin@airtrust.demo</b> (everything) · <b>operator@airtrust.demo</b> (start scenarios) · <b>researcher@airtrust.demo</b> · <b>citizen@airtrust.demo</b>. You can browse, report and verify without signing in.</div>
    <p class="muted" style="font-size:12px;margin-top:18px">All sensor data in this prototype is simulated and labelled as such. Thresholds derived from the WHO Global Air Quality Guidelines (2021). Guidance is general, not medical advice.</p>`;
}

document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]"); if (g) AT.showView(g.dataset.goto);
  if (e.target.closest("[data-start-tour]")) startTour();
  const a = e.target.closest("[data-ask]"); if (a) openAssistant(a.dataset.ask);
});

// ===================================================== map "how to read" help
$("#mapHelp")?.addEventListener("click", () => {
  $("#mBox").innerHTML = `<h2 id="mTitle" style="font-family:var(--font-display);margin:0 0 8px">How to read this screen</h2>
    <ol style="padding-left:18px;line-height:1.6;font-size:13px;margin:0 0 12px">
      <li><b>Map</b>: each dot is a sensor colored by risk. Hover for values; click for details and forecast.</li>
      <li><b>Left</b>: key numbers and the sensor list. Use the chips (PM2.5, PM10, NO₂…) to change what the map shows.</li>
      <li><b>Right, top</b>: the AI's current assessment: what it sees, how confident it is and what to do.</li>
      <li><b>Right, middle</b>: the active environmental event and its timeline (appears when something happens).</li>
      <li><b>Right, bottom</b>: the AI activity feed, every decision it makes, live.</li>
      <li><b>Bottom bar</b>: system health, AI latency, blockchain block and how many readings are sealed.</li>
    </ol>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="mTour">▶ Guided demo</button><button class="btn" id="mGuide">Full guide</button><button class="btn" id="mOk">Got it</button></div>`;
  $("#modal").classList.add("open");
  $("#mTour").onclick = () => { $("#modal").classList.remove("open"); startTour(); };
  $("#mGuide").onclick = () => { $("#modal").classList.remove("open"); AT.showView("guide"); };
  $("#mOk").onclick = () => $("#modal").classList.remove("open");
});

// ============================================================ welcome dialog
function welcome() {
  setTimeout(() => {
    let seen = false;
    try { seen = localStorage.getItem("airtrust_welcome") === "1"; } catch {}
    if (seen || tour || $("#modal").classList.contains("open")) return;
    $("#mBox").innerHTML = `<span class="micro">Welcome to</span><h2 id="mTitle" style="font-family:var(--font-display);margin:2px 0 8px;font-size:26px">AirTrust</h2>
      <p class="muted" style="margin:0 0 14px;line-height:1.55;font-size:13.5px">A command center that makes air-quality data <b style="color:var(--text-primary)">trustworthy</b>: sensors measure, citizens observe, AI explains, blockchain preserves. Everything you see is a <b style="color:var(--accent-warning)">simulated</b> pilot in Istanbul.</p>
      <div class="grid" style="gap:8px">
        <button class="btn primary" id="wTour" style="justify-content:flex-start">▶ Take the 2-minute guided demo <span class="dim" style="margin-left:auto;font-size:11px">recommended</span></button>
        <button class="btn" id="wGuide" style="justify-content:flex-start">📖 Read how it works</button>
        <button class="btn" id="wAsk" style="justify-content:flex-start">✦ Ask the AI a question</button>
        <button class="btn" id="wSkip" style="justify-content:flex-start">Explore on my own</button>
      </div>`;
    $("#modal").classList.add("open");
    const close = () => { $("#modal").classList.remove("open"); try { localStorage.setItem("airtrust_welcome", "1"); } catch {} };
    $("#wTour").onclick = () => { close(); startTour(); };
    $("#wGuide").onclick = () => { close(); AT.showView("guide"); };
    $("#wAsk").onclick = () => { close(); openAssistant(); };
    $("#wSkip").onclick = close;
  }, 2600);
}

// ============================================================== guided demo
let tour = null;
const STEPS = [
  {
    title: "The live map",
    body: "Each dot is an air-quality sensor in Istanbul, colored by risk. Readings arrive every 5 seconds and the AI checks each one. Notice <b>AT-011</b> (grey): it's offline. And <b>AT-010</b> has a purple ring: the AI doesn't fully trust it.",
    action: "Show me", run: async () => { AT.showView("command"); },
  },
  {
    title: "Why the AI distrusts AT-010",
    body: "Click AT-010 to see the AI's reasoning. It reads ~50% higher than its neighbours compared with when it was calibrated: <b>calibration drift</b>. Its data is flagged and kept out of official averages, and a maintenance alert was raised.",
    action: "Open AT-010", run: async () => { AT.showView("command"); AT.openSensor("AT-010"); },
  },
  {
    title: "Start a fire",
    body: "Now let's simulate a real event: a grass and waste fire next to the <b>İkitelli industrial zone (AT-007)</b>. This signs you in as admin and starts the scenario.",
    action: "Start the fire", run: async () => {
      document.querySelector("#dClose")?.click();
      AT.fitSensors();
      await AT.loginAs("admin@airtrust.demo");
      await AT.api("/api/scenarios/burning/trigger", { method: "POST" });
      AT.toast("Scenario started", "Fire next to İkitelli industrial zone (AT-007)", "info");
      AT.showView("command");
    },
  },
  {
    title: "Watch the AI confirm it",
    body: "AT-007's PM2.5 is rising. A single sensor could just be a glitch, so the AI first <b>holds it for review</b>, then checks the neighbours downwind (Bağcılar AT-004, Başakşehir AT-009). When they rise too, the reading becomes <b>anomalous with high confidence</b>.",
    wait: () => { const r = AT.S.latest["AT-007"]; return r && r.ai_status === "anomalous" && (r.checks?.neighbours_confirming || []).length > 0; },
    live: () => { const r = AT.S.latest["AT-007"]; return r ? `AT-007 · PM2.5 <b>${AT.fmt(r.pm25)}</b> µg/m³ · ${AT.label(r.ai_status)} · confidence ${r.confidence_score}%${(r.checks?.neighbours_confirming || []).length ? ` · confirmed by ${r.checks.neighbours_confirming.join(", ")}` : ""}` : "waiting for data…"; },
    done: "Confirmed by neighbouring sensors.",
  },
  {
    title: "A resident reports smoke",
    body: "Citizens are part of the network. Send a smoke report near the fire: the AI compares it with nearby sensors (distance, timing, pollution increase, wind) and scores the match from 0 to 100.",
    action: "Send the report", run: async (st) => {
      const r = await AT.api("/api/reports", { method: "POST", body: { type: "smoke", latitude: 41.072, longitude: 28.796, severity: "high", description: "Smoke from a grass fire next to the İkitelli industrial zone" } });
      AT.upsert(AT.S.reports, r, "code"); AT.renderReportsOnMap();
      st.result = `Report <b>${esc(r.code)}</b>: AI correlation <b>${r.ai_correlation_score}/100</b> (${AT.label(r.correlation_status)}).`;
    },
  },
  {
    title: "Event verified & sealed",
    body: "Sensors and the citizen agree, so the AI opens an <b>environmental event</b>. After it persists for a minute above 80% confidence it is <b>verified</b>, its evidence is fingerprinted (SHA-256) and written to the blockchain, and a <b>critical alert</b> goes out. Watch the event card on the right.",
    wait: () => AT.S.events.some((e) => !e.ended_at && e.status === "verified" && e.tx_hash),
    live: () => { const e = AT.S.events.find((x) => !x.ended_at && x.status !== "dismissed"); return e ? `${esc(e.title)} · <b>${AT.label(e.status)}</b> · confidence ${Math.round(e.confidence_score)}%${e.block_number ? ` · block #${e.block_number}` : ""}` : "waiting for the event to open…"; },
    done: "Sealed on the blockchain.",
  },
  {
    title: "Anyone can verify",
    body: "Open the public verification portal on one of the fire readings. It recomputes the fingerprint from the stored data, walks the Merkle proof and asks the smart contract. Readings are sealed in batches every 30 s.",
    action: "Verify a fire reading", run: async (st) => {
      for (let i = 0; i < 20; i++) {
        const d = await AT.api("/api/readings?sensor=AT-007&status=anomalous&anchored=true&limit=1");
        if (d.data[0]) { await AT.runVerify("reading", d.data[0].id); return; }
        st.result = "Waiting for the next blockchain batch (≤ 30 s)…"; renderCoach(); await sleep(3000);
      }
    },
  },
  {
    title: "Try to cheat",
    body: "Now act as an attacker with database access: quietly lower this reading's PM2.5 to hide the pollution. The blockchain fingerprint can't be changed, so the check must fail.",
    action: "Tamper with the record", run: async () => { AT.showView("verify"); await sleep(300); await $("#tamperBtn").onclick(); },
  },
  {
    title: "That's AirTrust",
    body: "<b>Integrity check failed</b>: the edit was caught. The AI makes sure measurements are credible; the blockchain makes sure nobody rewrites them. Restore the original value, then explore on your own or ask the AI anything.",
    action: "Restore & finish", run: async () => { if (!$("#restoreBtn").disabled) await $("#restoreBtn").onclick(); },
    final: true,
  },
];

function startTour() {
  tour = { i: 0, state: {} };
  AT.showView("command");
  renderCoach();
}

function renderCoach() {
  const box = $("#coach");
  if (!tour) { box.hidden = true; return; }
  const step = STEPS[tour.i], st = tour.state[tour.i] = tour.state[tour.i] || {};
  const ready = step.wait ? step.wait() : st.ran || !step.action;
  box.hidden = false;
  box.innerHTML = `
    <div class="ch"><span class="micro">Guided demo · step ${tour.i + 1} of ${STEPS.length}</span><button class="btn small" id="cX" aria-label="Close guided demo">✕</button></div>
    <div class="cbar"><i style="width:${((tour.i + (ready ? 1 : 0.5)) / STEPS.length) * 100}%"></i></div>
    <h3>${step.title}</h3>
    <p>${step.body}</p>
    ${step.live ? `<div class="clive ${ready ? "ok" : "processing"}">${ready ? "✔ " + step.done + "<br>" : ""}${step.live()}</div>` : ""}
    ${st.result ? `<div class="clive ok">${st.result}</div>` : ""}
    <div class="cbtns">
      ${tour.i > 0 ? `<button class="btn small" id="cBack">← Back</button>` : ""}
      ${step.action && !st.ran ? `<button class="btn primary" id="cDo" ${st.busy ? "disabled" : ""}>${st.busy ? "Working…" : step.action}</button>` : ""}
      ${step.final ? (st.ran ? `<button class="btn primary" id="cEnd">Finish</button>` : "") : `<button class="btn ${ready ? "primary" : ""}" id="cNext" ${ready ? "" : "disabled"}>${ready ? "Next →" : "Waiting…"}</button>`}
      ${!step.final && step.action && !st.ran ? `<button class="btn small" id="cSkip">Skip</button>` : ""}
    </div>`;
  $("#cX").onclick = () => { tour = null; renderCoach(); };
  $("#cBack") && ($("#cBack").onclick = () => { tour.i--; renderCoach(); });
  $("#cNext") && ($("#cNext").onclick = () => { tour.i++; renderCoach(); });
  $("#cSkip") && ($("#cSkip").onclick = () => { st.ran = true; tour.i++; renderCoach(); });
  $("#cEnd") && ($("#cEnd").onclick = () => { tour = null; renderCoach(); AT.toast("Guided demo complete", "Ask the AI anything with the ✦ button", "success"); });
  $("#cDo") && ($("#cDo").onclick = async () => {
    st.busy = true; renderCoach();
    try { await step.run(st); st.ran = true; }
    catch (e) { st.result = `<span style="color:var(--accent-danger)">${esc(e.message)}</span>`; }
    st.busy = false; renderCoach();
  });
}
setInterval(() => { if (tour && (STEPS[tour.i].wait || STEPS[tour.i].live)) renderCoach(); }, 1500);

// ============================================================ AI assistant
const chat = [];
const CHIPS = ["What's happening right now?", "Is it safe to run in Beşiktaş?", "Why is AT-010 flagged?", "What does each tab do?", "How does the blockchain verification work?", "Hava kalitesi şu an nasıl?"];
let busy = false;

function md(text) {
  const lines = esc(text).split("\n");
  let html = "", list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])_(.+?)_(?=[\s.,)]|$)/g, "$1<i>$2</i>").replace(/`(.+?)`/g, "<code>$1</code>");
  for (const l of lines) {
    const m = l.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (m) { const tag = m[1] ? "ol" : "ul"; if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; } html += `<li>${inline(m[2])}</li>`; continue; }
    if (list) { html += `</${list}>`; list = null; }
    if (/^#{1,4}\s/.test(l)) html += `<p><b>${inline(l.replace(/^#+\s/, ""))}</b></p>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (list) html += `</${list}>`;
  return html;
}

function renderChat() {
  const box = $("#aiMsgs");
  box.innerHTML = (chat.length ? "" : `<div class="msg bot"><p>Hi! I'm the AirTrust assistant. I answer from the <b>live</b> sensor, event and blockchain data. Ask me in English, Türkçe or Português.</p></div>`) +
    chat.map((m) => `<div class="msg ${m.role === "user" ? "me" : "bot"}">${m.role === "user" ? `<p>${esc(m.content)}</p>` : md(m.content)}${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}</div>`).join("") +
    (busy ? `<div class="msg bot processing"><p class="muted">Reading live data…</p></div>` : "");
  box.scrollTop = box.scrollHeight;
  $("#aiChips").innerHTML = chat.length > 2 ? "" : CHIPS.map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
}

async function ask(q) {
  q = q.trim(); if (!q || busy) return;
  chat.push({ role: "user", content: q }); busy = true; renderChat();
  try {
    const d = await AT.api("/api/assistant", { method: "POST", body: { messages: chat.map(({ role, content }) => ({ role, content })) } });
    chat.push({ role: "assistant", content: d.answer, note: d.fallback_reason ? "Answered by the offline assistant (AI provider unavailable)." : "" });
    setMode(d);
  } catch (e) { chat.push({ role: "assistant", content: `Sorry, I couldn't answer: ${e.message}` }); }
  busy = false; renderChat();
}

function setMode(d) {
  $("#aiMode").textContent = d.mode === "llm" ? `${d.provider} · ${d.model} · live data` : "Offline mode · answers from live data";
}

function openAssistant(q) {
  $("#aiPanel").hidden = false; $("#aiFab").setAttribute("aria-expanded", "true"); $("#aiFab").classList.add("open");
  renderChat(); $("#aiInput").focus();
  if (q) ask(q);
}
$("#aiFab").onclick = () => ($("#aiPanel").hidden ? openAssistant() : ($("#aiPanel").hidden = true, $("#aiFab").classList.remove("open"), $("#aiFab").setAttribute("aria-expanded", "false")));
$("#aiClose").onclick = () => { $("#aiPanel").hidden = true; $("#aiFab").classList.remove("open"); $("#aiFab").setAttribute("aria-expanded", "false"); };
$("#aiForm").onsubmit = (e) => { e.preventDefault(); const v = $("#aiInput").value; $("#aiInput").value = ""; ask(v); };
$("#aiChips").addEventListener("click", (e) => { const c = e.target.closest("[data-chip]"); if (c) ask(c.dataset.chip); });
AT.api("/api/assistant/status").then(setMode).catch(() => {});

AT.onGuide = renderGuide;
AT.startTour = startTour;
AT.openAssistant = openAssistant;
welcome();
})();
