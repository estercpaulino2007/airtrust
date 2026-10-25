// Seeds 30 days of simulated history, runs every reading through the AI engine, injects
// 5 historical environmental events + faults, 25 citizen reports, demo users, and anchors
// daily Merkle batches + verified events on the blockchain.
//
// Usage: node scripts/seed.js        (requires a running Hardhat node, see scripts/start.js)
const fs = require("fs");
const config = require("../server/config");
const { open } = require("../server/db");
const SENSORS = require("../server/sensors");
const { Simulator, SCENARIOS } = require("../server/simulator");
const { AirTrust } = require("../server/core");
const { Ledger } = require("../server/ledger");
const { hashPassword } = require("../server/auth");

async function seed({ log = console.log } = {}) {
  for (const f of [config.dbFile, config.dbFile + "-wal", config.dbFile + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = open();
  const now = Date.now();
  const STEP = config.seedStepMinutes * 60_000;
  const start = Math.floor((now - config.seedDays * 864e5) / STEP) * STEP;

  // Sensors ------------------------------------------------------------------------------
  const insS = db.prepare(`INSERT INTO sensors (code, name, latitude, longitude, district, profile, status, firmware_version, battery_level,
    signal_strength, installed_at, last_seen_at) VALUES (?,?,?,?,?,?, 'online', ?, 90, -65, ?, NULL)`);
  for (const s of SENSORS) insS.run(s.code, s.name, s.latitude, s.longitude, s.district, s.profile, s.code === "AT-010" ? "2.0.3" : "2.1.0", new Date(start - 120 * 864e5).toISOString());

  // Users (one per role) ------------------------------------------------------------------
  const insU = db.prepare("INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?,?,?,?,?)");
  for (const [email, name, role] of [
    ["admin@airtrust.demo", "Ada Admin", "admin"], ["operator@airtrust.demo", "Otto Operator", "operator"],
    ["researcher@airtrust.demo", "Rita Researcher", "researcher"], ["citizen@airtrust.demo", "Caio Citizen", "citizen"],
  ]) insU.run(email, hashPassword("AirTrust2026!"), name, role, new Date().toISOString());

  const insSc = db.prepare("INSERT INTO scenarios (id, name, description, type, duration_minutes, status, config) VALUES (?,?,?,?,?, 'idle', ?)");
  for (const s of SCENARIOS) insSc.run(s.id, s.name, s.description, s.type, s.duration_minutes, JSON.stringify({ center: s.center || null, radiusKm: s.radiusKm || null }));

  // Simulation ---------------------------------------------------------------------------
  let clock = start;
  const sim = new Simulator({ seed: 2026 });
  const core = new AirTrust({ db, ledger: null, simulator: sim, clock: () => clock });
  core.eventIdleMs = 45 * 60_000;
  core.verifyMinAgeMs = 15 * 60_000;

  // Train the Isolation Forest on 3 days of clean baseline.
  const train = [];
  for (let t = start - 3 * 864e5; t < start; t += STEP) train.push(...sim.tick(t, { includeScenarios: false }));
  core.engine.train(train);
  for (const r of train) core.engine.analyze(r); // warm profiles

  const day = (d, h) => { const t = new Date(now - d * 864e5); t.setUTCHours(Math.floor(h) - config.city.utcOffset, Math.round((h % 1) * 60), 0, 0); return t.getTime(); };
  const def = (id) => SCENARIOS.find((s) => s.id === id);
  const historical = [
    { id: "dust", at: day(26, 13), mins: 200 },
    { id: "industrial", at: day(19, 10), mins: 180 },
    { id: "sensor_fault", at: day(15, 2), mins: 240 },
    { id: "burning", at: day(12, 16), mins: 210 },
    { id: "spike", at: day(9, 4), mins: 25 },
    { id: "rush_hour", at: day(7, 7), mins: 200 },
    { id: "heatwave", at: day(3, 12), mins: 300 },
  ];
  // Citizen reports: most during events, some background noise.
  // Citizen reports: most during events, some background noise. Positioned relative to sensors.
  const at = (code, dLat = 0, dLng = 0) => { const s = SENSORS.find((x) => x.code === code); return { lat: +(s.latitude + dLat).toFixed(4), lng: +(s.longitude + dLng).toFixed(4) }; };
  const reports = [
    { at: day(26, 14), type: "dust", ...at("AT-010", 0.004, 0.005), severity: "high", d: "Thick dust cloud from the construction sites" },
    { at: day(26, 15), type: "dust", ...at("AT-010", -0.006, -0.004), severity: "medium", d: "Cars covered in dust, hard to breathe" },
    { at: day(19, 11), type: "industrial", ...at("AT-008", 0.002, -0.003), severity: "high", d: "Dark smoke from a factory chimney in Dudullu" },
    { at: day(19, 11.5), type: "odor", ...at("AT-008", -0.004, 0.004), severity: "medium", d: "Strong chemical smell in Ümraniye" },
    { at: day(19, 12), type: "industrial", ...at("AT-008", 0.005, 0.006), severity: "medium", d: "Grey haze over the industrial zone" },
    { at: day(12, 17), type: "smoke", ...at("AT-007", 0.003, -0.005), severity: "high", d: "Smoke from a grass fire next to İkitelli industrial zone" },
    { at: day(12, 17.4), type: "burning", ...at("AT-007", -0.004, 0.006), severity: "high", d: "Burning vegetation and waste, ash falling" },
    { at: day(12, 18), type: "smoke", ...at("AT-004", 0.004, -0.008), severity: "medium", d: "Smell of smoke in Bağcılar" },
    { at: day(12, 18.5), type: "smoke", ...at("AT-009", -0.003, 0.004), severity: "medium", d: "Hazy sky over Başakşehir" },
    { at: day(7, 8), type: "traffic", ...at("AT-002", -0.002, 0.003), severity: "medium", d: "Standstill traffic at Mecidiyeköy" },
    { at: day(7, 8.5), type: "traffic", ...at("AT-002", 0.006, -0.004), severity: "high", d: "Buses and trucks idling on Büyükdere Avenue" },
    { at: day(3, 14), type: "heat", ...at("AT-001", 0.002, -0.004), severity: "high", d: "Extreme heat in Sultanahmet, no wind" },
    { at: day(3, 15), type: "heat", ...at("AT-005", -0.003, -0.002), severity: "medium", d: "Very hot even at Emirgan Park" },
    { at: day(3, 15.5), type: "heat", ...at("AT-012", 0.004, 0.003), severity: "high", d: "Stagnant hot air, eyes burning" },
    // background / uncorroborated
    { at: day(28, 9), type: "odor", ...at("AT-011", 0.003, 0.004), severity: "low", d: "Sewage smell near the coast" },
    { at: day(24, 20), type: "smoke", ...at("AT-005", 0.002, 0.003), severity: "low", d: "Barbecue smoke in the park" },
    { at: day(22, 7), type: "traffic", ...at("AT-003", 0.003, -0.002), severity: "medium", d: "Heavy traffic on Barbaros Boulevard" },
    { at: day(17, 22), type: "smoke", ...at("AT-010", -0.005, 0.006), severity: "low", d: "Small fire in a backyard" },
    { at: day(14, 6), type: "dust", ...at("AT-012", -0.003, 0.004), severity: "low", d: "Construction dust" },
    { at: day(10, 13), type: "odor", ...at("AT-006", 0.002, 0.004), severity: "medium", d: "Fuel smell near the ferry pier" },
    { at: day(8, 18), type: "traffic", ...at("AT-002", 0.003, 0.002), severity: "medium", d: "Metrobus lane jammed" },
    { at: day(6, 11), type: "dust", ...at("AT-010", 0.006, -0.003), severity: "low", d: "Road works" },
    { at: day(5, 16), type: "smoke", ...at("AT-009", 0.004, 0.003), severity: "medium", d: "Burning trash near Başakşehir" },
    { at: day(2, 9), type: "industrial", ...at("AT-007", 0.001, 0.002), severity: "low", d: "Steam from a factory" },
    { at: day(1, 19), type: "traffic", ...at("AT-001", 0.003, 0.004), severity: "medium", d: "Evening congestion in Eminönü" },
  ].map((r) => ({ ...r, at: Math.round(r.at / 60_000) * 60_000 }));

  log(`Simulating ${config.seedDays} days × ${SENSORS.length} sensors…`);
  let count = 0;
  const stepsPerDay = 864e5 / STEP;
  let ri = 0;
  db.exec("BEGIN");
  for (let t = start, i = 0; t < now - STEP; t += STEP, i++) {
    clock = t;
    for (const h of historical) if (!h.started && t >= h.at) {
      h.started = true;
      sim.active = sim.active.filter((a) => a.def.id !== h.id);
      sim.active.push({ def: { ...def(h.id), duration_minutes: h.mins }, start: h.at, end: h.at + h.mins * 60_000 });
    }
    for (const p of sim.tick(t)) { core.ingest(p, { quiet: true, receivedAt: new Date(t + 1500).toISOString() }); count++; }
    while (ri < reports.length && reports[ri].at <= t) {
      const r = reports[ri++];
      clock = r.at;
      core.createReport({ type: r.type, latitude: r.lat, longitude: r.lng, severity: r.severity, description: r.d, created_at: new Date(r.at).toISOString(), quiet: true }, { id: 4 });
      clock = t;
    }
    if (i % stepsPerDay === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
  }
  db.exec("COMMIT");
  core.touchEvents(now, true);
  log(`  ${count} readings analysed`);

  // Blockchain anchoring ---------------------------------------------------------------
  const ledger = new Ledger({ db, log });
  if (await ledger.connect()) {
    core.ledger = ledger;
    log(`Anchoring daily Merkle batches on ${ledger.network.name} (contract ${ledger.address})…`);
    const days = db.prepare("SELECT DISTINCT substr(captured_at,1,10) d FROM readings ORDER BY d").all();
    for (const { d } of days) {
      const rows = db.prepare("SELECT id, data_hash, captured_at FROM readings WHERE substr(captured_at,1,10)=? AND batch_id IS NULL ORDER BY id").all(d);
      if (rows.length) await core.anchorRows(rows, true);
    }
    const evs = db.prepare("SELECT id FROM environmental_events WHERE status='verified' AND tx_hash IS NULL").all();
    for (const e of evs) await core.anchorEventProof(e.id, true);
    // Anchor the peak reading of each verified event individually (critical evidence).
    for (const e of db.prepare("SELECT * FROM environmental_events WHERE status='verified'").all()) {
      const codes = JSON.parse(e.sensor_codes);
      const peak = db.prepare(`SELECT id FROM readings WHERE sensor_code IN (${codes.map(() => "?").join(",")}) AND captured_at BETWEEN ? AND ? ORDER BY pm25 DESC LIMIT 1`)
        .get(...codes, e.started_at, e.ended_at || new Date().toISOString());
      if (peak) await core.anchorSingleReading(peak.id, true);
    }
    log(`  ${(await ledger.totals()).batches} batches, ${(await ledger.totals()).events} events, ${(await ledger.totals()).readings} single readings on-chain`);
  } else log(`! Ledger unavailable (${ledger.error}). History stored without on-chain proofs.`);

  const summary = {
    readings: db.prepare("SELECT COUNT(*) n FROM readings").get().n,
    events: db.prepare("SELECT status, COUNT(*) n FROM environmental_events GROUP BY status").all(),
    eventList: db.prepare("SELECT code, type, severity, status, confidence_score, sensor_codes, report_codes FROM environmental_events").all(),
    reports: db.prepare("SELECT correlation_status, COUNT(*) n FROM citizen_reports GROUP BY correlation_status").all(),
    anomalies: db.prepare("SELECT type, COUNT(*) n FROM anomalies GROUP BY type").all(),
  };
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('seeded_at', ?)").run(new Date().toISOString());
  db.close();
  return summary;
}

if (require.main === module) {
  seed().then((s) => { console.log(JSON.stringify(s, null, 1)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed };
