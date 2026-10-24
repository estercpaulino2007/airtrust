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

  const day = (d, h) => { const t = new Date(now - d * 864e5); t.setUTCHours(Math.floor(h) + 3, Math.round((h % 1) * 60), 0, 0); return t.getTime(); };
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
  const reports = [
    { at: day(26, 14), type: "dust", lat: -23.648, lng: -46.703, severity: "high", d: "Thick dust cloud near Largo Treze" },
    { at: day(26, 15), type: "dust", lat: -23.641, lng: -46.712, severity: "medium", d: "Cars covered in dust, hard to breathe" },
    { at: day(19, 11), type: "industrial", lat: -23.557, lng: -46.602, severity: "high", d: "Dark smoke from the rail yard chimney" },
    { at: day(19, 11.5), type: "odor", lat: -23.552, lng: -46.596, severity: "medium", d: "Strong chemical smell in Mooca" },
    { at: day(19, 12), type: "industrial", lat: -23.561, lng: -46.594, severity: "medium", d: "Grey haze over the depot" },
    { at: day(12, 17), type: "smoke", lat: -23.546, lng: -46.744, severity: "high", d: "Smoke from vacant lot fire near Jaguaré bridge" },
    { at: day(12, 17.4), type: "burning", lat: -23.552, lng: -46.739, severity: "high", d: "Burning vegetation, ash falling" },
    { at: day(12, 18), type: "smoke", lat: -23.565, lng: -46.722, severity: "medium", d: "Smell of smoke at USP campus" },
    { at: day(12, 18.5), type: "smoke", lat: -23.531, lng: -46.708, severity: "medium", d: "Hazy sky around Lapa station" },
    { at: day(7, 8), type: "traffic", lat: -23.562, lng: -46.654, severity: "medium", d: "Standstill traffic on Paulista" },
    { at: day(7, 8.5), type: "traffic", lat: -23.517, lng: -46.628, severity: "high", d: "Trucks idling on Marginal Tietê" },
    { at: day(3, 14), type: "heat", lat: -23.551, lng: -46.634, severity: "high", d: "Extreme heat downtown, no wind" },
    { at: day(3, 15), type: "heat", lat: -23.588, lng: -46.657, severity: "medium", d: "Very hot at Ibirapuera" },
    { at: day(3, 15.5), type: "heat", lat: -23.584, lng: -46.584, severity: "high", d: "Stagnant hot air, eyes burning" },
    // background / uncorroborated
    { at: day(28, 9), type: "odor", lat: -23.540, lng: -46.460, severity: "low", d: "Sewage smell" },
    { at: day(24, 20), type: "smoke", lat: -23.590, lng: -46.660, severity: "low", d: "Barbecue smoke in the park" },
    { at: day(22, 7), type: "traffic", lat: -23.567, lng: -46.690, severity: "medium", d: "Heavy traffic on Rebouças" },
    { at: day(17, 22), type: "smoke", lat: -23.655, lng: -46.705, severity: "low", d: "Small fire in a backyard" },
    { at: day(14, 6), type: "dust", lat: -23.581, lng: -46.585, severity: "low", d: "Construction dust" },
    { at: day(10, 13), type: "odor", lat: -23.517, lng: -46.627, severity: "medium", d: "Fuel smell near the river" },
    { at: day(8, 18), type: "traffic", lat: -23.560, lng: -46.657, severity: "medium", d: "Bus lane jammed" },
    { at: day(6, 11), type: "dust", lat: -23.648, lng: -46.709, severity: "low", d: "Road works" },
    { at: day(5, 16), type: "smoke", lat: -23.528, lng: -46.702, severity: "medium", d: "Burning trash near Lapa" },
    { at: day(2, 9), type: "industrial", lat: -23.550, lng: -46.748, severity: "low", d: "Steam from factory" },
    { at: day(1, 19), type: "traffic", lat: -23.551, lng: -46.633, severity: "medium", d: "Evening congestion downtown" },
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
