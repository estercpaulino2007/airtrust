// AirTrust core: ingestion pipeline, event reasoning, citizen-report correlation, alerts,
// Merkle batch anchoring and integrity verification. Emits live updates for the WebSocket layer.
const EventEmitter = require("events");
const config = require("./config");
const { Simulator } = require("./simulator");
const { ClimateEngine, levelFor, LEVELS, localHour } = require("./ai/engine");
const { forecastSensor } = require("./ai/forecast");
const { buildMerkle, getProof, verifyProof } = require("./lib/merkle");
const { hashReading, hashEvent, canonicalReading, canonicalEvent } = require("./lib/hashing");
const { distanceKm, bearingDeg, angleDiff, compass } = require("./lib/geo");

const EVENT_TITLES = {
  wildfire_smoke: "Biomass smoke plume", industrial_emission: "Industrial emission", dust_event: "Dust event",
  traffic_pollution: "Traffic pollution episode", heatwave: "Heatwave with stagnant air", sensor_fault: "Sensor fault",
  unknown_anomaly: "Unclassified air-quality anomaly",
};
const REPORT_TYPES = {
  smoke: { pollutant: "pm25", event: "wildfire_smoke" }, burning: { pollutant: "pm25", event: "wildfire_smoke" },
  dust: { pollutant: "pm10", event: "dust_event" }, industrial: { pollutant: "no2", event: "industrial_emission" },
  odor: { pollutant: "no2", event: "industrial_emission" }, traffic: { pollutant: "no2", event: "traffic_pollution" },
  heat: { pollutant: "temperature", event: "heatwave" },
};
const SEV_RANK = { good: 0, moderate: 1, poor: 2, very_poor: 3, critical: 4 };
const nowIso = () => new Date().toISOString();
const J = (v) => JSON.stringify(v);

class AirTrust extends EventEmitter {
  constructor({ db, ledger, simulator, clock = Date.now }) {
    super();
    this.db = db; this.ledger = ledger; this.clock = clock;
    this.sensors = db.prepare("SELECT * FROM sensors ORDER BY code").all();
    this.byCode = Object.fromEntries(this.sensors.map((s) => [s.code, s]));
    this.sim = simulator || new Simulator();
    this.engine = new ClimateEngine(this.sensors);
    this.lastAnomalyAt = {}; this.eventIdleMs = 120_000; this.verifyMinAgeMs = Number(process.env.VERIFY_MIN_AGE_S || 60) * 1000;
    this.stats = { readings: 0, startedAt: this.clock(), aiMs: 0 };
    this.prep();
  }

  prep() {
    const d = this.db;
    this.q = {
      insReading: d.prepare(`INSERT INTO readings (sensor_id, sensor_code, pm25, pm10, no2, o3, temperature, humidity, wind_speed, wind_direction,
        battery_level, signal_strength, captured_at, received_at, ai_status, confidence_score, anomaly_score, ai_explanation, data_hash, simulated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      updSensor: d.prepare("UPDATE sensors SET last_seen_at=?, battery_level=?, signal_strength=?, status=?, health_score=?, firmware_version=? WHERE code=?"),
      insAnomaly: d.prepare(`INSERT INTO anomalies (reading_id, sensor_id, sensor_code, type, severity, description, ai_explanation, confidence_score, anomaly_score,
        contributing_factors, recommended_action, detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      insAlert: d.prepare(`INSERT INTO alerts (sensor_id, sensor_code, event_id, pollutant, value, threshold, severity, message, recommendation, started_at, status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`),
      activeAlert: d.prepare("SELECT * FROM alerts WHERE sensor_code=? AND pollutant=? AND status='active' LIMIT 1"),
      resolveAlert: d.prepare("UPDATE alerts SET status='resolved', ended_at=? WHERE id=?"),
    };
  }

  log(level, msg, extra = {}) { this.emit("ai", { at: new Date(this.clock()).toISOString(), level, msg, ...extra }); }

  /** Warm the AI memory with the last 30 days stored in the DB (called at boot). */
  warmUp() {
    const since = new Date(this.clock() - config.seedDays * 864e5).toISOString();
    const rows = this.db.prepare("SELECT * FROM readings WHERE captured_at >= ? ORDER BY captured_at").all(since);
    this.engine.train(rows.slice(0, Math.min(rows.length, 5000)));
    for (const r of rows) this.engine.analyze(this.toPayload(r));
    return rows.length;
  }

  toPayload(r) {
    return { sensor_id: r.sensor_code, timestamp: r.captured_at, pm25: r.pm25, pm10: r.pm10, no2: r.no2, o3: r.o3,
      temperature: r.temperature, humidity: r.humidity, wind_speed: r.wind_speed, wind_direction: r.wind_direction,
      battery_level: r.battery_level, signal_strength: r.signal_strength };
  }

  // ------------------------------------------------------------------------- ingestion
  validatePayload(p) {
    const errors = [];
    if (!p || typeof p !== "object") return ["payload must be an object"];
    if (!this.byCode[p.sensor_id]) errors.push("unknown sensor_id");
    if (!p.timestamp || Number.isNaN(Date.parse(p.timestamp))) errors.push("timestamp must be ISO-8601");
    for (const k of ["pm25", "pm10", "no2", "o3", "temperature", "humidity", "wind_speed", "wind_direction"])
      if (typeof p[k] !== "number" || !Number.isFinite(p[k])) errors.push(`${k} must be a finite number`);
    return errors;
  }

  ingest(p, { quiet = false, receivedAt } = {}) {
    const errors = this.validatePayload(p);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400 });
    const t0 = performance.now();
    const a = this.engine.analyze(p);
    this.stats.aiMs = this.stats.aiMs * 0.95 + (performance.now() - t0) * 0.05;
    const s = this.byCode[p.sensor_id];
    const row = {
      sensor_code: s.code, captured_at: new Date(Date.parse(p.timestamp)).toISOString(),
      pm25: p.pm25, pm10: p.pm10, no2: p.no2, o3: p.o3, temperature: p.temperature, humidity: p.humidity,
      wind_speed: p.wind_speed, wind_direction: p.wind_direction,
    };
    const dataHash = hashReading(row);
    const info = this.q.insReading.run(s.id, s.code, p.pm25, p.pm10, p.no2, p.o3, p.temperature, p.humidity, p.wind_speed, p.wind_direction,
      p.battery_level ?? null, p.signal_strength ?? null, row.captured_at, receivedAt || new Date(this.clock()).toISOString(),
      a.ai_status, a.confidence_score, a.anomaly_score, J({ explanation: a.explanation, factors: a.contributing_factors, checks: a.checks, recommended_action: a.recommended_action, severity: a.severity }),
      dataHash, 1);
    const id = Number(info.lastInsertRowid);
    const status = a.ai_status === "sensor_fault" ? "fault" : a.checks.drift_factor > config.driftThreshold ? "maintenance" : "online";
    this.q.updSensor.run(row.captured_at, p.battery_level ?? null, p.signal_strength ?? null, status, a.checks.health, p.firmware_version || s.firmware_version, s.code);
    s.status = status; s.last_seen_at = row.captured_at;
    this.stats.readings++;

    const reading = { id, ...row, sensor_id: s.id, ai_status: a.ai_status, confidence_score: a.confidence_score, anomaly_score: a.anomaly_score,
      severity: a.severity, data_hash: dataHash, explanation: a.explanation, latitude: s.latitude, longitude: s.longitude, district: s.district,
      checks: a.checks, factors: a.contributing_factors, recommended_action: a.recommended_action };
    this.afterAnalysis(reading, a, quiet);
    return reading;
  }

  afterAnalysis(r, a, quiet) {
    const t = Date.parse(r.captured_at);
    const key = `${r.sensor_code}:${a.ai_status}`;
    const notable = a.ai_status !== "valid";
    if (notable && (!this.lastAnomalyAt[key] || t - this.lastAnomalyAt[key] > 60_000)) {
      this.lastAnomalyAt[key] = t;
      const type = a.ai_status === "sensor_fault" ? "zero_variance" : a.checks.drift_factor > config.driftThreshold ? "calibration_drift"
        : a.ai_status === "invalid" ? "physical_limit" : a.ai_status === "suspicious" ? "uncorroborated_spike" : "pollution_anomaly";
      this.q.insAnomaly.run(r.id, r.sensor_id, r.sensor_code, type, a.severity, `${type.replace(/_/g, " ")} at ${r.sensor_code}`, a.explanation,
        a.confidence_score, a.anomaly_score, J(a.contributing_factors), a.recommended_action, r.captured_at);
      if (!quiet) {
        this.log("info", `Analyzing ${r.sensor_code}… cross-checking ${a.checks.neighbours_checked.length} nearby sensors`, { sensor: r.sensor_code });
        this.log(a.ai_status === "anomalous" ? "critical" : "warning",
          `${a.ai_status === "anomalous" ? "Anomaly detected" : a.ai_status === "sensor_fault" ? "Sensor fault detected" : a.checks.drift_factor > config.driftThreshold ? "Calibration drift detected" : "Suspicious reading held for review"} at ${r.sensor_code}: anomaly ${a.anomaly_score}, confidence ${a.confidence_score}%`,
          { sensor: r.sensor_code, explanation: a.explanation });
      }
    }
    // Maintenance alerts
    if (a.ai_status === "sensor_fault") this.raiseAlert(r, "device", 0, 0, "maintenance", `${r.sensor_code} frozen: zero-variance readings`, "Dispatch maintenance; readings excluded from official averages.", quiet);
    else if (a.checks.drift_factor > config.driftThreshold) this.raiseAlert(r, "calibration", a.checks.drift_factor, config.driftThreshold, "maintenance", `${r.sensor_code} calibration drift (${Math.round((a.checks.drift_factor - 1) * 100)}% high)`, "Co-locate with reference station and recalibrate.", quiet);
    if (a.ai_status === "valid") { this.resolveAlert(r.sensor_code, "device", r.captured_at, quiet); if (a.checks.drift_factor < 1.2) this.resolveAlert(r.sensor_code, "calibration", r.captured_at, quiet); }

    if (a.ai_status === "anomalous" && SEV_RANK[a.severity] >= 1) this.reasonEvent(r, a, quiet);
    this.touchEvents(t, quiet);
  }

  raiseAlert(r, pollutant, value, threshold, severity, message, recommendation, quiet, eventId = null) {
    if (this.q.activeAlert.get(r.sensor_code, pollutant)) return;
    const info = this.q.insAlert.run(r.sensor_id, r.sensor_code, eventId, pollutant, value, threshold, severity, message, recommendation, r.captured_at);
    if (!quiet) this.emit("alert", this.db.prepare("SELECT * FROM alerts WHERE id=?").get(Number(info.lastInsertRowid)));
  }

  resolveAlert(code, pollutant, at, quiet) {
    const al = this.q.activeAlert.get(code, pollutant);
    if (!al) return;
    this.q.resolveAlert.run(at, al.id);
    if (!quiet) this.emit("alert", { ...al, status: "resolved", ended_at: at });
  }

  // ------------------------------------------------------------------- event reasoning
  classify(r, sensor, reportTypes = []) {
    const hour = localHour(Date.parse(r.captured_at));
    const ratio = r.pm25 / Math.max(r.pm10, 1);
    if (r.temperature >= 32 && r.wind_speed < 1.3) return "heatwave";
    if (reportTypes.includes("smoke") || reportTypes.includes("burning")) if (ratio > 0.45) return "wildfire_smoke";
    if ((reportTypes.includes("industrial") || reportTypes.includes("odor")) && r.no2 > 50) return "industrial_emission";
    if (sensor.profile === "industrial" && r.no2 > 100) return "industrial_emission";
    if (r.pm10 > 90 && ratio < 0.42) return "dust_event";
    if (r.no2 > 105) {
      const rush = (hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 21);
      return sensor.profile === "industrial" ? "industrial_emission" : sensor.profile === "traffic" || rush ? "traffic_pollution" : "industrial_emission";
    }
    if (r.pm25 > 30 && ratio > 0.5) return "wildfire_smoke";
    if (r.no2 > 75) return "traffic_pollution";
    return "unknown_anomaly";
  }

  reasonEvent(r, a, quiet) {
    const t = Date.parse(r.captured_at);
    const sensor = this.byCode[r.sensor_code];
    const open = this.db.prepare("SELECT * FROM environmental_events WHERE ended_at IS NULL AND status IN ('detected','verified')").all();
    const heatOpen = open.find((e) => e.type === "heatwave");
    const heat = (r.temperature >= 32 && r.wind_speed < 1.3) || (heatOpen && r.temperature >= 29);
    const near = (e) => JSON.parse(e.sensor_codes).some((c) => distanceKm(this.byCode[c], sensor) < 8);
    let ev = open.find((e) => (heat ? e.type === "heatwave" : e.type !== "heatwave" && near(e)));
    const timeline = ev ? JSON.parse(ev.timeline || "[]") : [];
    const nowS = r.captured_at;

    if (!ev) {
      const type = this.classify(r, sensor);
      const code = `EV-${r.captured_at.slice(0, 10).replace(/-/g, "")}-${String(this.db.prepare("SELECT COUNT(*) n FROM environmental_events").get().n + 1).padStart(3, "0")}`;
      const title = `${EVENT_TITLES[type]} — ${type === "heatwave" ? config.city.name : sensor.district}`;
      timeline.push({ at: nowS, step: "sensor_reading", detail: `${r.sensor_code} ${a.checks.lead_pollutant.toUpperCase()} ${r[a.checks.lead_pollutant] ?? r.pm25}` });
      timeline.push({ at: nowS, step: "ai_anomaly", detail: `Anomaly ${a.anomaly_score}, confidence ${a.confidence_score}%` });
      const info = this.db.prepare(`INSERT INTO environmental_events (code, title, type, severity, description, ai_explanation, latitude, longitude, district,
        started_at, confidence_score, status, sensor_codes, report_codes, peak_pm25, peak_pm10, timeline)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'detected', ?, '[]', ?, ?, ?)`).run(code, title, type, a.severity, a.explanation, a.explanation,
        sensor.latitude, sensor.longitude, sensor.district, nowS, Math.round(0.6 * a.confidence_score), J([r.sensor_code]), r.pm25, r.pm10, J(timeline));
      ev = this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(Number(info.lastInsertRowid));
      // Attach citizen reports that arrived shortly BEFORE the event was opened.
      const recent = this.db.prepare("SELECT * FROM citizen_reports WHERE event_id IS NULL AND ai_correlation_score >= 60 AND created_at >= ?")
        .all(new Date(t - 15 * 60_000).toISOString()).filter((rep) => distanceKm(rep, sensor) < 8);
      if (recent.length) {
        for (const rep of recent) timeline.push({ at: rep.created_at, step: "citizen_report", detail: `${rep.code} ${rep.type} (${Math.round(rep.ai_correlation_score)}/100)` });
        timeline.sort((x, y) => (x.at < y.at ? -1 : 1));
        this.db.prepare("UPDATE environmental_events SET report_codes=?, timeline=? WHERE id=?").run(J(recent.map((x) => x.code)), J(timeline), ev.id);
        this.db.prepare(`UPDATE citizen_reports SET event_id=? WHERE id IN (${recent.map(() => "?").join(",")})`).run(ev.id, ...recent.map((x) => x.id));
        ev = this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(ev.id);
        this.eventState = this.eventState || {};
        this.eventState[ev.code] = { conf: {}, peak: {}, lastActive: t, reportScore: Math.max(...recent.map((x) => x.ai_correlation_score)) };
        if (!quiet) this.log("success", `Linked ${recent.length} earlier citizen report(s) to ${code}: ${recent.map((x) => x.code).join(", ")}`, { event: code });
      }
      if (!quiet) { this.log("critical", `Environmental event ${code} opened: ${title}`, { event: code }); this.emit("event", this.decorateEvent(ev)); }
    }
    this.eventState = this.eventState || {};
    const st = (this.eventState[ev.code] = this.eventState[ev.code] || { conf: {}, peak: {}, lastActive: t, reportScore: 0 });
    st.conf[r.sensor_code] = a.confidence_score;
    if (!st.peak[r.sensor_code] || r.pm25 > st.peak[r.sensor_code].pm25) st.peak[r.sensor_code] = { id: r.id, pm25: r.pm25, value: r[a.checks.lead_pollutant] ?? r.pm25, pollutant: a.checks.lead_pollutant };
    st.lastActive = t;

    if (ev.status === "verified") { // frozen fields; only update peaks / timeline
      this.db.prepare("UPDATE environmental_events SET peak_pm25=MAX(peak_pm25, ?), peak_pm10=MAX(peak_pm10, ?) WHERE id=?").run(r.pm25, r.pm10, ev.id);
      return;
    }
    const sensors = JSON.parse(ev.sensor_codes);
    if (!sensors.includes(r.sensor_code)) {
      sensors.push(r.sensor_code);
      timeline.push({ at: nowS, step: "spatial_confirmation", detail: `${r.sensor_code} joins (${a.confidence_score}% confidence)` });
      if (!quiet) this.log("info", `Cross-sensor consensus: ${r.sensor_code} confirms ${ev.code} (${sensors.length} sensors)`, { event: ev.code });
    }
    const reports = JSON.parse(ev.report_codes);
    const reportTypes = reports.length ? this.db.prepare(`SELECT type FROM citizen_reports WHERE code IN (${reports.map(() => "?").join(",")})`).all(...reports).map((x) => x.type) : [];
    const confs = Object.values(st.conf);
    const avg = confs.reduce((x, y) => x + y, 0) / confs.length;
    const confidence = Math.min(99, 0.6 * avg + 25 * Math.min(1, (sensors.length - 1) / 2) + Math.min(1, st.reportScore / 80) * (reports.length >= 2 ? 25 : 18));
    const sev = LEVELS[Math.max(SEV_RANK[ev.severity] ?? 0, SEV_RANK[a.severity] ?? 0)];
    const type = ev.type === "heatwave" ? "heatwave" : this.classify(r, this.byCode[ev.sensor_codes ? JSON.parse(ev.sensor_codes)[0] : r.sensor_code], reportTypes);
    const bestType = type === "unknown_anomaly" ? ev.type : type;
    const title = `${EVENT_TITLES[bestType]} — ${bestType === "heatwave" ? config.city.name : ev.district}`;
    const explanation = this.eventExplanation(ev, bestType, sensors, reports, confidence, r);
    this.db.prepare(`UPDATE environmental_events SET sensor_codes=?, confidence_score=?, severity=?, type=?, title=?, ai_explanation=?, description=?,
      peak_pm25=MAX(peak_pm25, ?), peak_pm10=MAX(peak_pm10, ?), timeline=? WHERE id=?`)
      .run(J(sensors), +confidence.toFixed(1), sev, bestType, title, explanation, explanation, r.pm25, r.pm10, J(timeline), ev.id);

    const age = t - Date.parse(ev.started_at);
    if (confidence >= 80 && age >= this.verifyMinAgeMs) this.verifyEvent(ev.id, quiet);
    else if (!quiet) this.emit("event", this.decorateEvent(this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(ev.id)));
  }

  eventExplanation(ev, type, sensors, reports, confidence, r) {
    const st = this.eventState?.[ev.code];
    const peaks = st ? Object.entries(st.peak).map(([c, p]) => `${c} ${p.value.toFixed(0)}`).join(", ") : "";
    const why = {
      wildfire_smoke: "PM2.5 dominates PM10 (fine combustion particles)",
      dust_event: "PM10 dominates PM2.5 (coarse particles) with strong wind",
      industrial_emission: "NO2 and PM rise together next to an industrial source",
      traffic_pollution: "NO2-led increase along traffic corridors",
      heatwave: "high temperature with near-zero wind traps pollutants",
      unknown_anomaly: "signature does not match a known source",
    }[type];
    return `${EVENT_TITLES[type]} inferred because ${why}. ${sensors.length} sensor(s) involved (${sensors.join(", ")}); peaks: ${peaks}. ` +
      `${reports.length ? `${reports.length} citizen report(s) correlated (${reports.join(", ")}). ` : "No citizen report correlated yet. "}` +
      `Wind ${r.wind_speed.toFixed(1)} m/s from ${compass(r.wind_direction)}. Event confidence ${confidence.toFixed(0)}%.`;
  }

  async verifyEvent(id, quiet) {
    const ev = this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(id);
    if (!ev || ev.status === "verified" || this.verifying?.has(id)) return;
    (this.verifying = this.verifying || new Set()).add(id);
    const verifiedAt = new Date(this.clock()).toISOString();
    const timeline = JSON.parse(ev.timeline || "[]");
    timeline.push({ at: verifiedAt, step: "event_verified", detail: `Confidence ${Math.round(ev.confidence_score)}% ≥ 80%` });
    this.db.prepare("UPDATE environmental_events SET status='verified', verified_at=?, timeline=? WHERE id=?").run(verifiedAt, J(timeline), id);
    const frozen = this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(id);
    const hash = hashEvent(frozen);
    this.db.prepare("UPDATE environmental_events SET data_hash=? WHERE id=?").run(hash, id);

    // Critical alert
    const st = this.eventState?.[ev.code];
    const lead = st ? Object.values(st.peak).sort((x, y) => y.pm25 - x.pm25)[0] : null;
    const pollutant = ev.type === "heatwave" ? "temperature" : lead?.pollutant || "pm25";
    const firstSensor = this.byCode[JSON.parse(ev.sensor_codes)[0]];
    const level = config.thresholds[pollutant]?.find((x) => x.level === ev.severity);
    const prevMax = config.thresholds[pollutant] ? config.thresholds[pollutant][Math.max(0, SEV_RANK[ev.severity] - 1)].max : 32;
    const rec = SEV_RANK[ev.severity] >= 3 ? "Issue public alert: sensitive groups stay indoors, close windows, avoid outdoor exercise." : "Alert sensitive groups and schools in the affected area.";
    this.raiseAlert({ sensor_id: firstSensor.id, sensor_code: firstSensor.code, captured_at: verifiedAt }, `event:${ev.code}`, lead?.value ?? ev.peak_pm25,
      prevMax ?? level?.max, ev.severity, `${ev.title}: ${pollutant.toUpperCase()} peak ${(lead?.value ?? ev.peak_pm25).toFixed(1)} (${ev.severity.replace("_", " ")})`, rec, quiet, id);
    if (!quiet) { this.log("critical", `Event ${ev.code} VERIFIED (${Math.round(ev.confidence_score)}%). Hashing evidence with SHA-256…`, { event: ev.code }); this.emit("event", this.decorateEvent(this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(id))); }

    await this.anchorEventProof(id, quiet);
    this.emit("event", this.decorateEvent(this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(id)));
    this.verifying.delete(id);
  }

  async anchorEventProof(id, quiet) {
    if (!this.ledger?.ready) return null;
    const ev = this.db.prepare("SELECT * FROM environmental_events WHERE id=?").get(id);
    if (!ev || !ev.data_hash || ev.tx_hash) return null;
    try {
      const p = await this.ledger.anchorEvent(ev.data_hash, ev.type, ev.severity);
      const tl = JSON.parse(ev.timeline || "[]");
      const at = new Date(this.clock()).toISOString();
      tl.push({ at, step: "blockchain_proof", detail: `Block #${p.blockNumber}` });
      tl.push({ at, step: "alert_issued", detail: `${ev.severity.replace("_", " ")} alert` });
      this.db.prepare("UPDATE environmental_events SET tx_hash=?, block_number=?, timeline=? WHERE id=?").run(p.txHash, p.blockNumber, J(tl), id);
      if (!quiet) { this.log("success", `Event proof anchored on-chain: block #${p.blockNumber}, tx ${p.txHash.slice(0, 12)}…`, { event: ev.code }); this.emit("proof", { kind: "event", code: ev.code, ...p, dataHash: ev.data_hash }); }
      const st = this.eventState?.[ev.code];
      if (st) for (const pk of Object.values(st.peak)) await this.anchorSingleReading(pk.id, quiet);
      return p;
    } catch (e) { this.log("warning", `Ledger write failed for ${ev.code}: ${e.shortMessage || e.message}`); return null; }
  }

  async anchorSingleReading(readingId, quiet) {
    const r = this.db.prepare("SELECT * FROM readings WHERE id=?").get(readingId);
    if (!r || r.tx_hash) return r;
    const p = await this.ledger.anchorReading(r.data_hash, r.sensor_code, "pm25", r.pm25, r.ai_status);
    this.db.prepare("UPDATE readings SET tx_hash=?, block_number=?, verified_at=? WHERE id=?").run(p.txHash, p.blockNumber, nowIso(), readingId);
    if (!quiet) this.emit("proof", { kind: "reading", id: readingId, sensor: r.sensor_code, ...p, dataHash: r.data_hash });
    return { ...r, tx_hash: p.txHash, block_number: p.blockNumber };
  }

  /** Close events with no anomalous activity for 2 minutes. */
  touchEvents(t, quiet) {
    if (!this.eventState) return;
    for (const [code, st] of Object.entries(this.eventState)) {
      if (t - st.lastActive < this.eventIdleMs) continue;
      const ev = this.db.prepare("SELECT * FROM environmental_events WHERE code=?").get(code);
      delete this.eventState[code];
      if (!ev || ev.ended_at) continue;
      const end = new Date(t).toISOString();
      const status = ev.status === "verified" ? "verified" : "dismissed";
      const tl = JSON.parse(ev.timeline || "[]");
      tl.push({ at: end, step: status === "dismissed" ? "dismissed" : "event_ended", detail: status === "dismissed" ? "Not corroborated above 80% before it faded" : "Readings back to normal" });
      this.db.prepare("UPDATE environmental_events SET ended_at=?, status=?, timeline=? WHERE id=?").run(end, status, J(tl), ev.id);
      const al = this.db.prepare("SELECT * FROM alerts WHERE event_id=? AND status='active'").get(ev.id);
      if (al) { this.q.resolveAlert.run(end, al.id); if (!quiet) this.emit("alert", { ...al, status: "resolved", ended_at: end }); }
      if (!quiet) { this.log("info", `Event ${code} ${status === "dismissed" ? "dismissed (transient)" : "ended: air quality recovering"}`); this.emit("event", this.decorateEvent({ ...ev, ended_at: end, status, timeline: J(tl) })); }
    }
  }

  decorateEvent(e) {
    if (!e) return e;
    return { ...e, sensor_codes: JSON.parse(e.sensor_codes || "[]"), report_codes: JSON.parse(e.report_codes || "[]"), timeline: JSON.parse(e.timeline || "[]") };
  }

  // ------------------------------------------------------------- citizen signal network
  createReport(input, user) {
    const type = String(input.type || "").toLowerCase();
    if (!REPORT_TYPES[type]) throw Object.assign(new Error(`type must be one of ${Object.keys(REPORT_TYPES).join(", ")}`), { status: 400 });
    const lat = Number(input.latitude), lng = Number(input.longitude);
    const B = config.city.bounds;
    if (!(lat >= B.minLat && lat <= B.maxLat && lng >= B.minLng && lng <= B.maxLng)) throw Object.assign(new Error(`location must be inside the ${config.city.name} monitoring area`), { status: 400 });
    const severity = ["low", "medium", "high"].includes(input.severity) ? input.severity : "medium";
    const description = String(input.description || "").slice(0, 500);
    const photo = /^https?:\/\//.test(input.photo_url || "") ? input.photo_url : null;
    const createdAt = input.created_at || new Date(this.clock()).toISOString();
    const n = this.db.prepare("SELECT COUNT(*) n FROM citizen_reports").get().n;
    const code = `CR-${200 + n + 1}`;
    // Privacy: location rounded to ~110 m, no contact data stored with the report.
    const latR = Math.round(lat * 1000) / 1000, lngR = Math.round(lng * 1000) / 1000;
    const info = this.db.prepare(`INSERT INTO citizen_reports (code, user_id, type, description, latitude, longitude, severity, photo_url, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(code, user?.id ?? null, type, description, latR, lngR, severity, photo, createdAt);
    const report = this.db.prepare("SELECT * FROM citizen_reports WHERE id=?").get(Number(info.lastInsertRowid));
    if (!input.quiet) this.log("info", `Citizen report ${code} received (${type}). Correlating with sensor data…`, { report: code });
    return this.correlateReport(report, input.quiet);
  }

  correlateReport(report, quiet) {
    const spec = REPORT_TYPES[report.type];
    const t = Date.parse(report.created_at);
    const hour = localHour(t);
    const from = new Date(t - 20 * 60_000).toISOString(), to = new Date(t + 5 * 60_000).toISOString();
    const candidates = this.sensors.map((s) => ({ s, km: distanceKm(report, s) })).filter((c) => c.km <= 6).sort((a, b) => a.km - b.km);
    let best = { score: 0, parts: {}, sensor: null };
    const related = [];
    for (const { s, km } of candidates) {
      const rows = this.db.prepare(`SELECT * FROM readings WHERE sensor_code=? AND captured_at BETWEEN ? AND ? AND ai_status NOT IN ('sensor_fault','invalid')`).all(s.code, from, to);
      if (!rows.length) continue;
      const p = spec.pollutant;
      const peak = rows.reduce((m, r) => (r[p] > m[p] ? r : m), rows[0]);
      const typical = p === "temperature" ? 24 : Math.max(this.engine.typical(s.code, p, hour, rows[0][p]), p === "no2" ? 8 : 4);
      const increase = p === "temperature" ? (peak.temperature - typical) / 10 : (peak[p] - typical) / typical;
      const nb = this.engine.mem[s.code].neighbors.filter((n) => (this.engine.mem[n.code].latest?.rel || 1) > 1.4).length;
      const dirFromSensor = bearingDeg(s, report);
      const downwind = angleDiff(dirFromSensor, (peak.wind_direction + 180) % 360) < 60 || km < 0.8;
      const dt = Math.abs(t - Date.parse(peak.captured_at)) / 60_000;
      const level = p === "temperature" ? (peak.temperature > 33 ? 2 : 0) : SEV_RANK[levelFor(p, peak[p])] ?? 0;
      const declared = { low: 1, medium: 2, high: 3 }[report.severity];
      const parts = {
        distance: 25 * Math.max(0, 1 - km / 6),
        time: 15 * Math.max(0, 1 - dt / 25),
        pollutant_increase: 30 * Math.max(0, Math.min(1, increase / 1.5)),
        wind: downwind ? 10 : 3,
        neighbour_confirmation: 10 * Math.min(1, nb / 2),
        severity_alignment: Math.abs(level - declared) <= 1 ? 10 : 4,
      };
      const score = Object.values(parts).reduce((a, b) => a + b, 0);
      if (increase > 0.3) related.push(s.code);
      if (score > best.score) best = { score, parts, sensor: s, km, peak, increase, p, downwind };
    }
    const score = Math.round(best.score);
    const status = score >= 80 ? "strong_correlation" : score >= 60 ? "probable_correlation" : score >= 35 ? "weak_correlation" : "no_correlation";
    const explanation = best.sensor
      ? `Nearest corroborating sensor ${best.sensor.code} at ${best.km.toFixed(1)} km recorded ${best.p.toUpperCase()} ${best.peak[best.p].toFixed(1)} (${best.increase >= 0 ? "+" : ""}${Math.round(best.increase * 100)}% vs typical). ${best.downwind ? "Report lies downwind of the sensor." : "Report is not downwind of the sensor."} Score ${score}/100 (${status.replace("_", " ")}).`
      : "No sensor data within 6 km in the last 20 minutes. Report kept for future correlation.";
    let eventId = null;
    if (score >= 60) {
      const open = this.db.prepare("SELECT * FROM environmental_events WHERE ended_at IS NULL AND status IN ('detected','verified')").all();
      const ev = open.find((e) => distanceKm(e, report) < 8);
      if (ev) {
        eventId = ev.id;
        if (ev.status === "detected") {
          const reports = JSON.parse(ev.report_codes); reports.push(report.code);
          const tl = JSON.parse(ev.timeline || "[]"); tl.push({ at: report.created_at, step: "citizen_report", detail: `${report.code} ${report.type} (${score}/100)` });
          this.db.prepare("UPDATE environmental_events SET report_codes=?, timeline=? WHERE id=?").run(J(reports), J(tl), ev.id);
          this.eventState = this.eventState || {};
          const st = (this.eventState[ev.code] = this.eventState[ev.code] || { conf: {}, peak: {}, lastActive: t, reportScore: 0 });
          st.reportScore = Math.max(st.reportScore, score);
        }
        if (!quiet) this.log("success", `Correlating citizen report ${report.code} with ${ev.code}: ${score}/100 (${status.replace("_", " ")})`, { report: report.code, event: ev.code });
      }
    }
    if (!quiet && !eventId) this.log(score >= 60 ? "success" : "info", `Report ${report.code}: correlation ${score}/100 (${status.replace("_", " ")})`, { report: report.code });
    this.db.prepare(`UPDATE citizen_reports SET ai_correlation_score=?, correlation_status=?, correlation_explanation=?, related_sensor_ids=?, event_id=? WHERE id=?`)
      .run(score, status, explanation, J(related), eventId, report.id);
    const out = { ...this.db.prepare("SELECT * FROM citizen_reports WHERE id=?").get(report.id), correlation_parts: best.parts };
    out.related_sensor_ids = JSON.parse(out.related_sensor_ids || "[]");
    if (!quiet) this.emit("report", out);
    return out;
  }

  // ------------------------------------------------------------------- live simulation
  tick() {
    const t = this.clock();
    const readings = this.sim.tick(t);
    const out = readings.map((p) => this.ingest(p));
    // Offline detection
    for (const s of this.sensors) {
      const last = s.last_seen_at ? Date.parse(s.last_seen_at) : 0;
      if (t - last > Math.max(30_000, config.tickMs * 4) && s.status !== "offline") {
        s.status = "offline";
        this.db.prepare("UPDATE sensors SET status='offline' WHERE code=?").run(s.code);
        this.raiseAlert({ sensor_id: s.id, sensor_code: s.code, captured_at: new Date(t).toISOString() }, "connectivity", 0, 0, "maintenance", `${s.code} offline (last data ${s.last_seen_at ? s.last_seen_at.slice(0, 16).replace("T", " ") + " UTC" : "never"})`, "Check power and LTE gateway.", false);
        this.log("warning", `Sensor ${s.code} went offline`, { sensor: s.code });
        this.emit("sensor", s);
      } else if (s.status !== "offline" && t - last <= config.tickMs * 2) this.resolveAlert(s.code, "connectivity", new Date(t).toISOString(), false);
    }
    const anomalies = out.filter((r) => r.ai_status !== "valid").length;
    const meanConf = out.length ? Math.round(out.reduce((a, r) => a + r.confidence_score, 0) / out.length) : 0;
    this.log("trace", `Validated ${out.length} readings · ${out.length - anomalies} valid · mean confidence ${meanConf}%`);
    this.emit("readings", out);
    return out;
  }

  // ------------------------------------------------------------------ Merkle batching
  async anchorPending({ quiet = false, before } = {}) {
    if (!this.ledger?.ready || this.anchoring) return null;
    this.anchoring = true;
    try {
      const rows = this.db.prepare(`SELECT id, data_hash, captured_at FROM readings WHERE batch_id IS NULL ${before ? "AND captured_at < ?" : ""} ORDER BY id LIMIT 20000`)
        .all(...(before ? [before] : []));
      if (!rows.length) return null;
      return await this.anchorRows(rows, quiet);
    } finally { this.anchoring = false; }
  }

  async anchorRows(rows, quiet) {
    const tree = buildMerkle(rows.map((r) => r.data_hash));
    const from = rows.reduce((m, r) => (r.captured_at < m ? r.captured_at : m), rows[0].captured_at);
    const to = rows.reduce((m, r) => (r.captured_at > m ? r.captured_at : m), rows[0].captured_at);
    if (!quiet) this.log("info", `Building Merkle tree over ${rows.length} readings…`);
    const p = await this.ledger.anchorBatch(tree.root, rows.length, Date.parse(from), Date.parse(to));
    const info = this.db.prepare("INSERT INTO batches (merkle_root, reading_count, from_time, to_time, tx_hash, block_number, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(tree.root, rows.length, from, to, p.txHash, p.blockNumber, new Date(this.clock()).toISOString());
    const batchId = Number(info.lastInsertRowid);
    const upd = this.db.prepare("UPDATE readings SET batch_id=?, merkle_proof=? WHERE id=?");
    this.db.exec("BEGIN");
    rows.forEach((r, i) => upd.run(batchId, J(getProof(tree, i)), r.id));
    this.db.exec("COMMIT");
    const batch = { id: batchId, merkle_root: tree.root, reading_count: rows.length, from_time: from, to_time: to, tx_hash: p.txHash, block_number: p.blockNumber };
    if (!quiet) { this.log("success", `Merkle root of ${rows.length} readings anchored: block #${p.blockNumber}`); this.emit("proof", { kind: "batch", ...batch }); }
    return batch;
  }

  // ------------------------------------------------------------- integrity verification
  async verifyReading(id) {
    const r = this.db.prepare("SELECT * FROM readings WHERE id=?").get(id);
    if (!r) throw Object.assign(new Error("reading not found"), { status: 404 });
    const canonical = canonicalReading(r);
    const recomputed = hashReading(r);
    const steps = [{ step: "Load stored record", ok: true, detail: `Reading #${r.id} from ${r.sensor_code} at ${r.captured_at}` },
      { step: "Normalise payload + SHA-256", ok: true, detail: recomputed }];
    let onChain = null, batch = null, ok = false, single = null;
    if (r.batch_id) {
      batch = this.db.prepare("SELECT * FROM batches WHERE id=?").get(r.batch_id);
      const proof = JSON.parse(r.merkle_proof);
      const offChain = verifyProof(recomputed, proof, batch.merkle_root);
      steps.push({ step: "Walk Merkle proof", ok: offChain, detail: `${proof.length} sibling hashes → root ${batch.merkle_root.slice(0, 16)}…` });
      if (this.ledger?.ready) {
        onChain = await this.ledger.verifyBatchMembership(batch.merkle_root, recomputed, proof);
        steps.push({ step: "Smart contract verifyBatchMembership()", ok: onChain, detail: `Contract ${this.ledger.address.slice(0, 10)}… · block #${batch.block_number}` });
      }
      ok = onChain ?? offChain;
    }
    if (r.tx_hash && this.ledger?.ready) {
      single = await this.ledger.verifyReading(recomputed);
      steps.push({ step: "Smart contract verifyReadingProof()", ok: single, detail: `Individually anchored critical reading · tx ${r.tx_hash.slice(0, 14)}…` });
      ok = (r.batch_id ? ok : true) && single;
    }
    const pending = !r.batch_id && !r.tx_hash;
    const storedMatches = recomputed === r.data_hash;
    return {
      kind: "reading", id: r.id, status: pending ? "pending" : ok ? "verified" : "failed",
      message: pending ? "Not anchored yet: included in the next Merkle batch (≤ 30 s)." : ok ? "Data integrity verified" : "Integrity check failed: the stored data no longer matches the on-chain proof",
      recomputed_hash: recomputed, stored_hash: r.data_hash, stored_hash_matches: storedMatches, canonical_payload: canonical,
      record: { sensor: r.sensor_code, captured_at: r.captured_at, pm25: r.pm25, pm10: r.pm10, no2: r.no2, o3: r.o3, temperature: r.temperature, ai_status: r.ai_status, confidence_score: r.confidence_score },
      batch: batch && { id: batch.id, merkle_root: batch.merkle_root, reading_count: batch.reading_count, tx_hash: batch.tx_hash, block_number: batch.block_number },
      single_proof: r.tx_hash ? { tx_hash: r.tx_hash, block_number: r.block_number } : null,
      contract: this.ledger?.address, network: this.ledger?.network, steps,
    };
  }

  async verifyEventIntegrity(id) {
    const e = this.db.prepare("SELECT * FROM environmental_events WHERE id=? OR code=?").get(Number(id) || -1, String(id));
    if (!e) throw Object.assign(new Error("event not found"), { status: 404 });
    if (e.status !== "verified" || !e.data_hash) return { kind: "event", id: e.id, code: e.code, status: "pending", message: "Event not verified yet: no proof to check." };
    const recomputed = hashEvent(e);
    const steps = [{ step: "Load stored event", ok: true, detail: `${e.code} · ${e.title}` }, { step: "Normalise frozen fields + SHA-256", ok: true, detail: recomputed }];
    let ok = false;
    if (this.ledger?.ready && e.tx_hash) {
      ok = await this.ledger.verifyEvent(recomputed);
      steps.push({ step: "Smart contract verifyEventProof()", ok, detail: `Block #${e.block_number} · tx ${e.tx_hash.slice(0, 14)}…` });
    } else steps.push({ step: "Smart contract lookup", ok: false, detail: e.tx_hash ? "Ledger offline" : "Anchoring pending" });
    return {
      kind: "event", id: e.id, code: e.code, status: ok ? "verified" : e.tx_hash ? "failed" : "pending",
      message: ok ? "Data integrity verified" : e.tx_hash ? "Integrity check failed: the stored event no longer matches the on-chain proof" : "Anchoring pending",
      recomputed_hash: recomputed, stored_hash: e.data_hash, canonical_payload: canonicalEvent(e), tx_hash: e.tx_hash, block_number: e.block_number,
      contract: this.ledger?.address, network: this.ledger?.network, steps,
    };
  }

  // ---------------------------------------------------------------------- forecasting
  forecast(code) {
    const s = this.byCode[code];
    if (!s) throw Object.assign(new Error("sensor not found"), { status: 404 });
    const since = new Date(this.clock() - 48 * 3.6e6).toISOString();
    const hourly = this.db.prepare(`SELECT CAST(strftime('%s', substr(captured_at,1,13) || ':00:00') AS INTEGER) * 1000 AS t,
        AVG(pm25) pm25, AVG(pm10) pm10, AVG(temperature) temperature FROM readings
      WHERE sensor_code=? AND captured_at >= ? AND ai_status IN ('valid','anomalous') GROUP BY substr(captured_at,1,13) ORDER BY t`).all(code, since);
    const nbCodes = this.engine.mem[code].neighbors.map((n) => n.code);
    const nb = this.db.prepare(`SELECT CAST(strftime('%s', substr(captured_at,1,13) || ':00:00') AS INTEGER) * 1000 AS t, AVG(pm25) nb_pm25, AVG(pm10) nb_pm10
      FROM readings WHERE sensor_code IN (${nbCodes.map(() => "?").join(",")}) AND captured_at >= ? AND ai_status IN ('valid','anomalous') GROUP BY substr(captured_at,1,13)`).all(...nbCodes, since);
    const nbMap = Object.fromEntries(nb.map((x) => [x.t, x]));
    for (const h of hourly) Object.assign(h, nbMap[h.t] ? { nb_pm25: nbMap[h.t].nb_pm25, nb_pm10: nbMap[h.t].nb_pm10 } : {});
    const latest = this.db.prepare("SELECT * FROM readings WHERE sensor_code=? ORDER BY captured_at DESC LIMIT 1").get(code);
    if (!latest) return { sensor: code, horizons: [], note: "No data" };
    return { sensor: code, ...forecastSensor(hourly, latest) };
  }
}

module.exports = { AirTrust, REPORT_TYPES, EVENT_TITLES };
