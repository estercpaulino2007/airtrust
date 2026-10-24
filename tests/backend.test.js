// Backend tests (node:test). Run with: npm run test:backend
const test = require("node:test");
const assert = require("node:assert/strict");
const { open } = require("../server/db");
const SENSORS = require("../server/sensors");
const { Simulator } = require("../server/simulator");
const { AirTrust } = require("../server/core");
const { ClimateEngine } = require("../server/ai/engine");
const { forecastSensor } = require("../server/ai/forecast");
const { hashReading, hashEvent } = require("../server/lib/hashing");
const { buildMerkle, getProof, verifyProof, sha256Hex } = require("../server/lib/merkle");
const auth = require("../server/auth");

const STEP = 20 * 60_000;

/** Builds an in-memory AirTrust with 6 days of AI-analysed history. */
function setup() {
  const db = open(":memory:");
  const ins = db.prepare("INSERT INTO sensors (code, name, latitude, longitude, district, profile, status, firmware_version) VALUES (?,?,?,?,?,?, 'online', '2.1.0')");
  for (const s of SENSORS) ins.run(s.code, s.name, s.latitude, s.longitude, s.district, s.profile);
  let clock = Date.now() - 6 * 864e5;
  const sim = new Simulator({ seed: 11 });
  sim.persistent = { driftStart: {}, offlineSince: {} };
  const core = new AirTrust({ db, ledger: null, simulator: sim, clock: () => clock });
  const train = [];
  for (let t = clock - 2 * 864e5; t < clock; t += STEP) train.push(...sim.tick(t, { includeScenarios: false }));
  core.engine.train(train);
  for (const r of train) core.engine.analyze(r);
  for (; clock < Date.now() - 60_000; clock += STEP) for (const p of sim.tick(clock)) core.ingest(p, { quiet: true });
  return { db, sim, core, setClock: (t) => (clock = t), now: () => clock };
}

function runLive(ctx, seconds, onTick) {
  let t = Date.now();
  const out = [];
  for (let i = 0; i < seconds / 5; i++) {
    t += 5000; ctx.setClock(t);
    for (const p of ctx.sim.tick(t)) { const r = ctx.core.ingest(p, { quiet: true }); out.push(r); onTick && onTick(r, i); }
  }
  return out;
}

test("reading ingestion validates payloads", () => {
  const ctx = setup();
  assert.throws(() => ctx.core.ingest({ sensor_id: "NOPE" }), /unknown sensor_id/);
  const r = ctx.core.ingest({ sensor_id: "AT-001", timestamp: new Date().toISOString(), pm25: 12, pm10: 20, no2: 30, o3: 40, temperature: 22, humidity: 60, wind_speed: 2, wind_direction: 140 });
  assert.ok(r.id > 0);
  assert.match(r.data_hash, /^[0-9a-f]{64}$/);
});

test("physically impossible readings are classified invalid", () => {
  const ctx = setup();
  const r = ctx.core.ingest({ sensor_id: "AT-002", timestamp: new Date().toISOString(), pm25: -5, pm10: 20, no2: 30, o3: 40, temperature: 99, humidity: 60, wind_speed: 2, wind_direction: 140 });
  assert.equal(r.ai_status, "invalid");
  assert.ok(r.confidence_score <= 20);
});

test("AI detects a confirmed burning event with spatial consensus and high confidence", () => {
  const ctx = setup();
  ctx.sim.trigger("burning", Date.now());
  const rs = runLive(ctx, 150);
  const at007 = rs.filter((r) => r.sensor_code === "AT-007").slice(-6);
  assert.ok(at007.every((r) => r.ai_status === "anomalous"), "AT-007 should be anomalous");
  assert.ok(at007.at(-1).confidence_score >= 85, `confidence ${at007.at(-1).confidence_score}`);
  assert.ok(at007.at(-1).checks.neighbours_confirming.length >= 1, "neighbours should confirm");
  const ev = ctx.db.prepare("SELECT * FROM environmental_events WHERE type='wildfire_smoke' ORDER BY id DESC").get();
  assert.ok(ev, "an environmental event should be created");
  assert.equal(ev.status, "verified");
  assert.match(ev.data_hash, /^[0-9a-f]{64}$/);
  const alert = ctx.db.prepare("SELECT * FROM alerts WHERE event_id=?").get(ev.id);
  assert.ok(["critical", "very_poor"].includes(alert.severity), "critical alert issued");
});

test("isolated spike without neighbour confirmation is held as suspicious", () => {
  const ctx = setup();
  ctx.sim.trigger("spike", Date.now());
  const rs = runLive(ctx, 15).filter((r) => r.sensor_code === "AT-005" && r.pm25 > 300);
  assert.ok(rs.length);
  for (const r of rs) {
    assert.equal(r.ai_status, "suspicious");
    assert.ok(r.confidence_score < 65);
  }
});

test("zero-variance (stuck) sensor is flagged as sensor_fault", () => {
  const ctx = setup();
  ctx.sim.trigger("sensor_fault", Date.now());
  const rs = runLive(ctx, 70).filter((r) => r.sensor_code === "AT-012");
  assert.equal(rs.at(-1).ai_status, "sensor_fault");
  assert.ok(ctx.db.prepare("SELECT * FROM alerts WHERE sensor_code='AT-012' AND severity='maintenance' AND status='active'").get());
});

test("calibration drift is detected", () => {
  const ctx = setup();
  ctx.sim.trigger("drift", Date.now());
  const rs = runLive(ctx, 300).filter((r) => r.sensor_code === "AT-003");
  assert.ok(rs.slice(-10).some((r) => r.checks.drift_factor > 1.25), `drift ${rs.at(-1).checks.drift_factor}`);
});

test("citizen report near an active plume correlates strongly and links to the event", () => {
  const ctx = setup();
  ctx.sim.trigger("burning", Date.now());
  runLive(ctx, 60);
  const rep = ctx.core.createReport({ type: "smoke", latitude: -23.546, longitude: -46.744, severity: "high", created_at: new Date(ctx.now()).toISOString(), quiet: true });
  assert.ok(rep.ai_correlation_score >= 60, `score ${rep.ai_correlation_score}`);
  assert.ok(["strong_correlation", "probable_correlation"].includes(rep.correlation_status));
  const far = ctx.core.createReport({ type: "smoke", latitude: -23.54, longitude: -46.46, severity: "high", created_at: new Date(ctx.now()).toISOString(), quiet: true });
  assert.ok(far.ai_correlation_score < rep.ai_correlation_score);
  assert.equal(Math.round(rep.latitude * 1000), rep.latitude * 1000, "location rounded for privacy");
});

test("forecast returns 1/3/6 h horizons with confidence intervals", () => {
  const hourly = Array.from({ length: 36 }, (_, i) => ({ t: Date.now() - (36 - i) * 3.6e6, pm25: 15 + 5 * Math.sin(i / 4), pm10: 30, temperature: 22, nb_pm25: 15 }));
  const fc = forecastSensor(hourly, { captured_at: new Date().toISOString(), pm25: 18, pm10: 30, temperature: 22 });
  const pm = fc.horizons.filter((h) => h.metric === "pm25");
  assert.deepEqual(pm.map((h) => h.horizon_hours), [1, 3, 6]);
  for (const h of pm) assert.ok(h.lower <= h.predicted && h.predicted <= h.upper);
});

test("SHA-256 hash changes when any hashed field changes", () => {
  const r = { sensor_code: "AT-007", captured_at: "2026-10-24T18:00:00.000Z", pm25: 92.47, pm10: 120, no2: 30, o3: 40, temperature: 24, humidity: 60, wind_speed: 2, wind_direction: 260 };
  assert.equal(hashReading(r), hashReading({ ...r }));
  assert.notEqual(hashReading(r), hashReading({ ...r, pm25: 36.99 }));
  const e = { code: "EV-1", title: "x", type: "wildfire_smoke", severity: "critical", latitude: -23.5, longitude: -46.7, started_at: "a", sensor_codes: '["AT-007","AT-004"]', report_codes: "[]", confidence_score: 94, verified_at: "b" };
  assert.equal(hashEvent(e), hashEvent({ ...e, sensor_codes: '["AT-004","AT-007"]' }), "sensor order does not matter");
  assert.notEqual(hashEvent(e), hashEvent({ ...e, severity: "moderate" }));
});

test("Merkle proofs verify every leaf and reject tampered leaves", () => {
  for (const n of [1, 2, 3, 7, 64, 101]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256Hex("leaf" + i));
    const tree = buildMerkle(leaves);
    leaves.forEach((l, i) => assert.ok(verifyProof(l, getProof(tree, i), tree.root)));
    assert.equal(verifyProof(sha256Hex("evil"), getProof(tree, 0), tree.root), n === 1 ? false : false);
  }
});

test("JWT auth and role hierarchy", () => {
  const h = auth.hashPassword("AirTrust2026!");
  assert.ok(auth.checkPassword("AirTrust2026!", h));
  assert.ok(!auth.checkPassword("wrong", h));
  const tok = auth.sign({ sub: 1, email: "a@b", role: "operator" });
  assert.equal(auth.verify(tok).role, "operator");
  assert.equal(auth.verify(tok.slice(0, -2) + "xx"), null, "tampered token rejected");
  assert.ok(auth.atLeast({ role: "admin" }, "operator"));
  assert.ok(!auth.atLeast({ role: "citizen" }, "operator"));
  assert.ok(!auth.atLeast({ role: "public" }, "citizen"));
});

test("historical engine: Isolation Forest scores outliers higher than normal points", () => {
  const eng = new ClimateEngine(SENSORS);
  const sim = new Simulator({ seed: 3 });
  const data = [];
  for (let t = Date.now() - 2 * 864e5; t < Date.now(); t += STEP) data.push(...sim.tick(t, { includeScenarios: false }));
  eng.train(data);
  const { features } = require("../server/ai/isolationForest");
  const normal = eng.forest.score(features(data[10]));
  const outlier = eng.forest.score(features({ ...data[10], pm25: 400, pm10: 60, no2: 300 }));
  assert.ok(outlier > normal, `${outlier} > ${normal}`);
});
