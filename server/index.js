// AirTrust HTTP API + WebSocket gateway + static command center.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const config = require("./config");
const { open } = require("./db");
const { AirTrust } = require("./core");
const { Ledger } = require("./ledger");
const auth = require("./auth");
const openapi = require("./openapi");
const assistant = require("./ai/assistant");

const PUBLIC = path.join(__dirname, "..", "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ------------------------------------------------------------------------- rate limiting
const buckets = new Map();
function rateLimit(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++; buckets.set(key, b);
  return b.n <= limit;
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(new HttpError(413, "payload too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new HttpError(400, "invalid JSON")); }
    });
  });
}

const parseJSONFields = (row, fields) => { for (const f of fields) if (row && typeof row[f] === "string") { try { row[f] = JSON.parse(row[f]); } catch {} } return row; };

function paginate(url) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  return { page, limit, offset: (page - 1) * limit };
}

async function main() {
  const db = open();
  if (!db.prepare("SELECT COUNT(*) n FROM sensors").get().n) {
    console.error("Database is empty. Run `npm run seed` (or `npm start`, which seeds automatically).");
    process.exit(1);
  }
  const ledger = new Ledger({ db, log: console.log });
  await ledger.connect();
  console.log(ledger.ready ? `Ledger connected: ${ledger.network.name} · contract ${ledger.address}` : `! Ledger offline: ${ledger.error}`);

  const core = new AirTrust({ db, ledger });
  const t0 = Date.now();
  const warm = core.warmUp();
  console.log(`AI engine warmed with ${warm} historical readings in ${Date.now() - t0} ms`);

  const audit = (user, action, entity, id, meta = {}) =>
    db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, created_at) VALUES (?,?,?,?,?,?)")
      .run(user?.id ?? null, action, entity, String(id ?? ""), JSON.stringify(meta), new Date().toISOString());

  const sensorView = (s) => {
    const latest = db.prepare("SELECT * FROM readings WHERE sensor_code=? ORDER BY captured_at DESC LIMIT 1").get(s.code);
    return { ...s, simulated: true, latest: latest && parseJSONFields({ ...latest }, ["ai_explanation"]) };
  };

  // ---------------------------------------------------------------------------- routes
  const routes = [];
  const route = (method, pattern, role, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, role, handler });
  };

  route("GET", "/api/health", "public", async () => ({
    status: "ok", uptime_s: Math.round(process.uptime()), readings_ingested: core.stats.readings,
    ai_latency_ms: +core.stats.aiMs.toFixed(2), ledger: await ledger.status(),
    sensors_online: core.sensors.filter((s) => s.status !== "offline").length, sensors_total: core.sensors.length,
    simulated_data: true,
  }));

  route("POST", "/api/auth/login", "public", async ({ body, req }) => {
    if (!rateLimit("login:" + req.socket.remoteAddress, 20)) throw new HttpError(429, "too many login attempts");
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(body.email || "").toLowerCase());
    if (!u || !auth.checkPassword(String(body.password || ""), u.password_hash)) throw new HttpError(401, "invalid credentials");
    audit(u, "login", "user", u.id);
    return { token: auth.sign({ sub: u.id, email: u.email, role: u.role, name: u.name }), user: { id: u.id, email: u.email, name: u.name, role: u.role } };
  });
  route("GET", "/api/auth/me", "citizen", async ({ user }) => user);

  // Sensors
  route("GET", "/api/sensors", "public", async () => core.sensors.map(sensorView));
  route("GET", "/api/sensors/:id", "public", async ({ p }) => {
    const s = core.sensors.find((x) => x.code === p.id || String(x.id) === p.id);
    if (!s) throw new HttpError(404, "sensor not found");
    return sensorView(s);
  });
  route("GET", "/api/sensors/:id/health", "public", async ({ p }) => {
    const s = core.byCode[p.id]; if (!s) throw new HttpError(404, "sensor not found");
    const day = new Date(Date.now() - 864e5).toISOString();
    const dist = db.prepare("SELECT ai_status, COUNT(*) n, AVG(confidence_score) c FROM readings WHERE sensor_code=? AND captured_at>=? GROUP BY ai_status").all(s.code, day);
    const mem = core.engine.mem[s.code];
    return { sensor: s.code, status: s.status, health_score: s.health_score, battery_level: s.battery_level, signal_strength: s.signal_strength,
      firmware_version: s.firmware_version, last_seen_at: s.last_seen_at, last_24h: dist,
      calibration: { baseline_ratio: mem.baselineRatio, current_ratio: mem.ratioEwma, drift_factor: mem.baselineRatio != null && mem.ratioEwma != null ? +Math.exp(mem.ratioEwma - mem.baselineRatio).toFixed(2) : null },
      neighbours: mem.neighbors.map((n) => ({ code: n.code, km: +n.km.toFixed(2) })) };
  });
  route("GET", "/api/sensors/:id/history", "public", async ({ p, url }) => {
    const hours = Math.min(24 * 30, Number(url.searchParams.get("hours") || 24));
    const since = new Date(Date.now() - hours * 3.6e6).toISOString();
    const bucket = hours <= 2 ? 16 : 13; // minute vs hour buckets
    return db.prepare(`SELECT substr(captured_at,1,${bucket}) t, AVG(pm25) pm25, AVG(pm10) pm10, AVG(no2) no2, AVG(o3) o3, AVG(temperature) temperature,
      AVG(confidence_score) confidence, MAX(anomaly_score) anomaly FROM readings WHERE sensor_code=? AND captured_at>=? GROUP BY t ORDER BY t`).all(p.id, since);
  });

  // Readings
  route("POST", "/api/readings", "public", async ({ body, req, user }) => {
    const deviceOk = req.headers["x-device-key"] === (process.env.DEVICE_KEY || "demo-device-key");
    if (!deviceOk && !auth.atLeast(user, "operator")) throw new HttpError(401, "device key or operator token required");
    const items = Array.isArray(body) ? body : [body];
    if (items.length > 100) throw new HttpError(413, "max 100 readings per request");
    const out = items.map((p) => core.ingest(p));
    core.emit("readings", out);
    return out.map((r) => ({ id: r.id, ai_status: r.ai_status, confidence_score: r.confidence_score, anomaly_score: r.anomaly_score, data_hash: r.data_hash, explanation: r.explanation }));
  });
  route("GET", "/api/readings", "public", async ({ url }) => {
    const { limit, offset, page } = paginate(url);
    const where = [], args = [];
    for (const [k, col] of [["sensor", "sensor_code"], ["status", "ai_status"]]) { const v = url.searchParams.get(k); if (v) { where.push(`${col}=?`); args.push(v); } }
    if (url.searchParams.get("anchored") === "true") where.push("batch_id IS NOT NULL");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (from) { where.push("captured_at>=?"); args.push(from); }
    if (to) { where.push("captured_at<=?"); args.push(to); }
    const sortCol = ["captured_at", "pm25", "pm10", "confidence_score", "anomaly_score"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "captured_at";
    const dir = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = db.prepare(`SELECT COUNT(*) n FROM readings ${w}`).get(...args).n;
    const data = db.prepare(`SELECT * FROM readings ${w} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`).all(...args, limit, offset).map((r) => parseJSONFields(r, ["ai_explanation", "merkle_proof"]));
    return { page, limit, total, data };
  });
  route("GET", "/api/readings/:id", "public", async ({ p }) => {
    const r = db.prepare("SELECT * FROM readings WHERE id=?").get(Number(p.id));
    if (!r) throw new HttpError(404, "reading not found");
    return parseJSONFields(r, ["ai_explanation", "merkle_proof"]);
  });

  // AI outputs
  route("GET", "/api/anomalies", "public", async ({ url }) => {
    const { limit, offset } = paginate(url);
    return db.prepare("SELECT * FROM anomalies ORDER BY detected_at DESC LIMIT ? OFFSET ?").all(limit, offset).map((r) => parseJSONFields(r, ["contributing_factors"]));
  });
  route("GET", "/api/alerts", "public", async ({ url }) => {
    const status = url.searchParams.get("status");
    return db.prepare(`SELECT * FROM alerts ${status ? "WHERE status=?" : ""} ORDER BY started_at DESC LIMIT 200`).all(...(status ? [status] : []));
  });
  route("GET", "/api/forecasts/:sensorId", "public", async ({ p }) => core.forecast(p.sensorId));
  route("GET", "/api/events", "public", async () => db.prepare("SELECT * FROM environmental_events ORDER BY started_at DESC").all().map((e) => core.decorateEvent(e)));
  route("GET", "/api/events/:id", "public", async ({ p }) => {
    const e = db.prepare("SELECT * FROM environmental_events WHERE id=? OR code=?").get(Number(p.id) || -1, p.id);
    if (!e) throw new HttpError(404, "event not found");
    const reports = db.prepare("SELECT * FROM citizen_reports WHERE event_id=?").all(e.id);
    return { ...core.decorateEvent(e), reports };
  });

  // Citizen reports
  route("POST", "/api/reports", "public", async ({ body, req, user }) => {
    if (!rateLimit("report:" + req.socket.remoteAddress, 15)) throw new HttpError(429, "too many reports, try again in a minute");
    const out = core.createReport({ ...body, created_at: undefined, quiet: false }, user.id ? user : null);
    audit(user, "create", "citizen_report", out.code, { type: out.type });
    return out;
  });
  route("GET", "/api/reports", "public", async () => db.prepare("SELECT * FROM citizen_reports ORDER BY created_at DESC LIMIT 200").all().map((r) => parseJSONFields(r, ["related_sensor_ids"])));

  // Blockchain
  route("POST", "/api/blockchain/proofs", "operator", async ({ body, user }) => {
    if (!ledger.ready) throw new HttpError(503, "ledger offline");
    if (body.reading_id) { const r = await core.anchorSingleReading(Number(body.reading_id)); audit(user, "anchor", "reading", body.reading_id); return r; }
    if (body.event_id) { await core.verifyEvent(Number(body.event_id)); audit(user, "anchor", "event", body.event_id); return core.decorateEvent(db.prepare("SELECT * FROM environmental_events WHERE id=?").get(Number(body.event_id))); }
    const b = await core.anchorPending(); audit(user, "anchor", "batch", b?.id); return b || { message: "nothing pending" };
  });
  route("GET", "/api/blockchain/proofs", "public", async () => ({
    ledger: await ledger.status(),
    batches: db.prepare("SELECT * FROM batches ORDER BY id DESC LIMIT 50").all(),
    events: db.prepare("SELECT id, code, title, type, severity, data_hash, tx_hash, block_number, verified_at FROM environmental_events WHERE tx_hash IS NOT NULL ORDER BY verified_at DESC").all(),
    readings: db.prepare("SELECT id, sensor_code, pm25, ai_status, captured_at, data_hash, tx_hash, block_number FROM readings WHERE tx_hash IS NOT NULL ORDER BY id DESC LIMIT 50").all(),
  }));
  route("GET", "/api/verify/reading/:id", "public", async ({ p }) => core.verifyReading(Number(p.id)));
  route("GET", "/api/verify/event/:id", "public", async ({ p }) => core.verifyEventIntegrity(p.id));

  // Demo-only: simulate a database attacker editing a stored record (admin only, audited).
  route("POST", "/api/demo/tamper", "admin", async ({ body, user }) => {
    if (body.reading_id) {
      const r = db.prepare("SELECT * FROM readings WHERE id=?").get(Number(body.reading_id));
      if (!r) throw new HttpError(404, "reading not found");
      const original = r.pm25, tampered = body.restore ? Number(body.original) : +(r.pm25 * (body.factor || 0.4)).toFixed(2);
      db.prepare("UPDATE readings SET pm25=? WHERE id=?").run(tampered, r.id);
      audit(user, body.restore ? "restore" : "tamper", "reading", r.id, { field: "pm25", from: original, to: tampered });
      core.log(body.restore ? "info" : "critical", body.restore ? `Reading #${r.id} restored to original value` : `⚠ Demo: reading #${r.id} PM2.5 silently edited in the database (${original} → ${tampered})`);
      return { reading_id: r.id, field: "pm25", original, tampered };
    }
    if (body.event_id) {
      const e = db.prepare("SELECT * FROM environmental_events WHERE id=? OR code=?").get(Number(body.event_id) || -1, String(body.event_id));
      if (!e) throw new HttpError(404, "event not found");
      const to = body.restore ? body.original : "moderate";
      db.prepare("UPDATE environmental_events SET severity=? WHERE id=?").run(to, e.id);
      audit(user, body.restore ? "restore" : "tamper", "event", e.id, { field: "severity", from: e.severity, to });
      core.log(body.restore ? "info" : "critical", body.restore ? `Event ${e.code} restored` : `⚠ Demo: event ${e.code} severity downgraded in the database (${e.severity} → ${to})`);
      return { event_id: e.id, field: "severity", original: e.severity, tampered: to };
    }
    throw new HttpError(400, "reading_id or event_id required");
  });

  // Scenarios
  route("GET", "/api/scenarios", "public", async () => core.sim.listScenarios());
  route("POST", "/api/scenarios/:scenarioId/trigger", "operator", async ({ p, user }) => {
    const def = core.sim.trigger(p.scenarioId);
    audit(user, "trigger", "scenario", p.scenarioId);
    core.log("info", `Scenario simulator: "${def.name}" triggered by ${user.email}`);
    core.emit("scenarios", core.sim.listScenarios());
    return { triggered: def.id, scenarios: core.sim.listScenarios() };
  });

  // Research export (open data, rate limited)
  const exportRows = (url) => {
    const days = Math.min(30, Number(url.searchParams.get("days") || 7));
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const sensor = url.searchParams.get("sensor");
    const official = url.searchParams.get("official") === "true"; // only AI-trusted readings
    return db.prepare(`SELECT id, sensor_code, captured_at, pm25, pm10, no2, o3, temperature, humidity, wind_speed, wind_direction, ai_status, confidence_score,
      anomaly_score, data_hash, batch_id, tx_hash FROM readings WHERE captured_at>=? ${sensor ? "AND sensor_code=?" : ""} ${official ? "AND ai_status IN ('valid','anomalous')" : ""} ORDER BY captured_at`)
      .all(since, ...(sensor ? [sensor] : []));
  };
  route("GET", "/api/export/readings.json", "public", async ({ url }) => ({ simulated: true, license: "CC-BY-4.0", generated_at: new Date().toISOString(), data: exportRows(url) }));
  route("GET", "/api/export/readings.csv", "public", async ({ url, res }) => {
    const rows = exportRows(url);
    const cols = rows.length ? Object.keys(rows[0]) : ["id"];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n");
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=airtrust-readings.csv", "Access-Control-Allow-Origin": "*" });
    res.end(csv);
    return undefined;
  });

  // Admin
  route("GET", "/api/admin/overview", "admin", async () => ({
    users: db.prepare("SELECT id, email, name, role, created_at FROM users").all(),
    thresholds: config.thresholds,
    audit_logs: db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100").all(),
    health: { readings: db.prepare("SELECT COUNT(*) n FROM readings").get().n, ai_latency_ms: core.stats.aiMs, ledger: await ledger.status() },
  }));
  route("PUT", "/api/admin/thresholds/:pollutant", "admin", async ({ p, body, user }) => {
    const levels = config.thresholds[p.pollutant];
    if (!levels || !Array.isArray(body.max) || body.max.length !== 4 || body.max.some((v, i) => typeof v !== "number" || (i && v <= body.max[i - 1])))
      throw new HttpError(400, "max must be 4 increasing numbers (good, moderate, poor, very_poor upper bounds)");
    body.max.forEach((v, i) => (levels[i].max = v));
    audit(user, "update", "thresholds", p.pollutant, { max: body.max });
    return levels;
  });

  route("GET", "/api/openapi.json", "public", async () => openapi);

  // Embedded AI assistant (bring-your-own-key LLM, offline fallback grounded in live data)
  route("GET", "/api/assistant/status", "public", async () => assistant.status());
  route("POST", "/api/assistant", "public", async ({ body, req }) => {
    if (!rateLimit("assistant:" + req.socket.remoteAddress, 20)) throw new HttpError(429, "Too many questions, wait a minute.");
    const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && typeof m.content === "string").slice(-12) : [];
    if (!messages.length) throw new HttpError(400, "messages[] required");
    return assistant.answer({ messages, core, db, ledgerStatus: await ledger.status() });
  });
  route("GET", "/api/stats", "public", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    return {
      readings_per_minute: db.prepare("SELECT COUNT(*) n FROM readings WHERE captured_at>=?").get(since).n,
      active_anomalies: db.prepare("SELECT COUNT(DISTINCT sensor_code) n FROM readings WHERE captured_at>=? AND ai_status='anomalous'").get(since).n,
      active_alerts: db.prepare("SELECT COUNT(*) n FROM alerts WHERE status='active'").get().n,
      critical_alerts: db.prepare("SELECT COUNT(*) n FROM alerts WHERE status='active' AND severity IN ('critical','very_poor')").get().n,
      verified_events: db.prepare("SELECT COUNT(*) n FROM environmental_events WHERE status='verified'").get().n,
      correlated_reports: db.prepare("SELECT COUNT(*) n FROM citizen_reports WHERE ai_correlation_score>=60").get().n,
      total_readings: db.prepare("SELECT COUNT(*) n FROM readings").get().n,
      anchored_readings: db.prepare("SELECT COUNT(*) n FROM readings WHERE batch_id IS NOT NULL").get().n,
      ai_latency_ms: +core.stats.aiMs.toFixed(2),
      sensors_online: core.sensors.filter((s) => s.status !== "offline").length, sensors_total: core.sensors.length,
    };
  });

  // ---------------------------------------------------------------------------- server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const cors = { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Key", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

    if (url.pathname.startsWith("/api/")) {
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json", ...cors }); res.end(JSON.stringify(obj)); };
      try {
        if (!rateLimit("api:" + req.socket.remoteAddress, 600)) throw new HttpError(429, "rate limit exceeded");
        if (url.pathname === "/api/docs") { res.writeHead(302, { Location: "/docs.html" }); return res.end(); }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const user = auth.principal(req);
          if (!auth.atLeast(user, r.role)) throw new HttpError(user.role === "public" ? 401 : 403, `requires role ${r.role}`);
          const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
          const out = await r.handler({ req, res, url, p, body, user });
          if (out !== undefined) send(200, out);
          return;
        }
        throw new HttpError(404, "route not found");
      } catch (e) {
        const status = e.status || 500;
        if (status === 500) console.error(e);
        return send(status, { error: { status, message: e.message } });
      }
    }
    // static
    let file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });

  // WebSocket gateway
  const wss = new WebSocketServer({ server, path: "/ws" });
  const broadcast = (type, data) => { const msg = JSON.stringify({ type, data }); for (const c of wss.clients) if (c.readyState === 1) c.send(msg); };
  const slim = (r) => ({ id: r.id, sensor_code: r.sensor_code, captured_at: r.captured_at, pm25: r.pm25, pm10: r.pm10, no2: r.no2, o3: r.o3, temperature: r.temperature, humidity: r.humidity,
    wind_speed: r.wind_speed, wind_direction: r.wind_direction, ai_status: r.ai_status, confidence_score: r.confidence_score, anomaly_score: r.anomaly_score, severity: r.severity,
    explanation: r.explanation, checks: r.checks, data_hash: r.data_hash, recommended_action: r.recommended_action, factors: r.factors });
  core.on("readings", (rs) => broadcast("readings", rs.map(slim)));
  for (const ev of ["ai", "event", "alert", "proof", "report", "scenarios"]) core.on(ev, (d) => broadcast(ev, d));
  core.on("sensor", (s) => broadcast("sensor", s));
  wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", data: { simulated: true, ledger: ledger.ready, contract: ledger.address } })));

  setInterval(() => { try { core.tick(); } catch (e) { console.error("tick", e); } }, config.tickMs);
  setInterval(() => core.anchorPending().catch((e) => core.log("warning", `Batch anchoring failed: ${e.message}`)), config.batchMs);
  setInterval(async () => { if (!ledger.ready && await ledger.connect()) core.log("success", "Ledger reconnected"); }, 15_000);

  server.listen(config.port, () => console.log(`\n  AirTrust command center → http://localhost:${config.port}\n  API docs → http://localhost:${config.port}/docs.html\n`));
}

main().catch((e) => { console.error(e); process.exit(1); });
