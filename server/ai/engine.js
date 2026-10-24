// AI Climate Engine: explainable validation + anomaly detection for every reading.
//
// Two separate axes are produced for each reading:
//   anomaly_score    (0-100) "is something unusual happening in the air?"
//   confidence_score (0-100) "how much do we trust this measurement?"
// A pollution event is HIGH anomaly + HIGH confidence (confirmed by neighbours).
// A sensor glitch is HIGH anomaly + LOW confidence (no confirmation, abrupt, isolated).
//
// Methods: physical limits, z-score vs 24h history, moving-average deviation, hour-of-day
// historical profile, spatial consensus with nearest sensors, zero-variance (stuck) detection,
// calibration-drift tracking and a multivariate Isolation Forest.
const config = require("../config");
const { distanceKm, bearingDeg, angleDiff, compass } = require("../lib/geo");
const { IsolationForest, features } = require("./isolationForest");

const POLLUTANTS = ["pm25", "pm10", "no2", "o3"];
const LABEL = { pm25: "PM2.5", pm10: "PM10", no2: "NO2", o3: "O3" };
const LEVELS = ["good", "moderate", "poor", "very_poor", "critical"];
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const localHour = (t) => (new Date(t).getUTCHours() + 21) % 24; // UTC-3

function levelFor(pollutant, value, thresholds = config.thresholds) {
  const t = thresholds[pollutant];
  if (!t) return "good";
  return t.find((x) => value <= x.max).level;
}

function worstLevel(r) {
  let worst = 0, pollutant = "pm25";
  for (const p of POLLUTANTS) {
    const i = LEVELS.indexOf(levelFor(p, r[p]));
    if (i > worst) { worst = i; pollutant = p; }
  }
  if (r.temperature >= 36 && worst < 3) { worst = 3; pollutant = "temperature"; }
  else if (r.temperature >= 33 && worst < 2) { worst = 2; pollutant = "temperature"; }
  return { level: LEVELS[worst], pollutant };
}

class ClimateEngine {
  constructor(sensors, { rand } = {}) {
    this.sensors = sensors;
    this.forest = new IsolationForest({ trees: 100, sampleSize: 256, rand });
    this.mem = {};
    for (const s of sensors) {
      const others = sensors.filter((o) => o.code !== s.code)
        .map((o) => ({ code: o.code, km: distanceKm(s, o), bearing: bearingDeg(s, o) }))
        .sort((a, b) => a.km - b.km);
      const near = others.filter((o, i) => i < 3 || o.km <= config.neighborRadiusKm).slice(0, 5);
      this.mem[s.code] = {
        sensor: s, neighbors: near, hist: [], raw: [], latest: null,
        profile: Object.fromEntries(POLLUTANTS.map((p) => [p, new Array(24).fill(null)])),
        ratioEwma: null, baselineRatio: null, ratioSamples: [],
      };
    }
  }

  train(readings) {
    const valid = readings.filter((r) => r.pm25 != null).map(features);
    if (valid.length > 50) this.forest.fit(valid);
  }

  typical(code, pollutant, hour, fallback) {
    const v = this.mem[code].profile[pollutant][hour];
    return v == null ? fallback : v;
  }

  relOf(code, r, hour, means) {
    let best = { rel: 1, pollutant: "pm25" };
    for (const p of ["pm25", "pm10", "no2"]) {
      const typ = Math.max(this.typical(code, p, hour, means[p] ?? r[p]), p === "no2" ? 8 : 4);
      const rel = r[p] / typ * (p === "no2" ? 0.9 : 1);
      if (rel > best.rel) best = { rel, pollutant: p, typical: typ };
    }
    if (!best.typical) best.typical = Math.max(this.typical(code, "pm25", hour, means.pm25 ?? r.pm25), 4);
    return best;
  }

  /** Analyse one reading. `r` uses the device payload format (sensor_id, timestamp, pm25 ...). */
  analyze(r) {
    const code = r.sensor_id;
    const m = this.mem[code];
    if (!m) throw new Error(`unknown sensor ${code}`);
    const t = Date.parse(r.timestamp);
    const hour = localHour(t);
    const factors = [];

    // 1. Physical validity --------------------------------------------------------------
    const violations = Object.entries(config.physicalLimits)
      .filter(([k, [lo, hi]]) => r[k] != null && (r[k] < lo || r[k] > hi)).map(([k]) => k);
    const physical = violations.length ? 0 : 100;
    if (violations.length) factors.push({ factor: "physical_limits", impact: "-", detail: `Out of physical range: ${violations.join(", ")}` });

    // 2. Temporal: 24h z-score + moving-average deviation ------------------------------
    const win = m.hist.filter((x) => x.t > t - 864e5 && x.t < t);
    const means = {};
    for (const p of POLLUTANTS) means[p] = win.length ? win.reduce((a, x) => a + x[p], 0) / win.length : null;
    const mean = means.pm25 ?? r.pm25;
    const std = win.length > 5 ? Math.max(2, Math.sqrt(win.reduce((a, x) => a + (x.pm25 - mean) ** 2, 0) / win.length), 0.15 * mean) : Math.max(3, 0.25 * mean);
    const z = (r.pm25 - mean) / std;
    const recent = m.raw.slice(-6);
    const ma = recent.length ? recent.reduce((a, x) => a + x.pm25, 0) / recent.length : r.pm25;
    const maDev = Math.abs(r.pm25 - ma) / Math.max(ma, 5);
    const temporal = clamp(100 - Math.max(0, maDev - 0.5) * 45 - Math.min(10, Math.abs(z)));
    if (maDev > 1) factors.push({ factor: "abrupt_change", impact: "-", detail: `PM2.5 jumped ${Math.round(maDev * 100)}% vs moving average (${ma.toFixed(1)} µg/m³)` });

    // 3. Zero variance (stuck firmware) --------------------------------------------------
    const tail = [...m.raw.slice(-9), r];
    const stuck = tail.length >= 8 && tail.every((x) => x.pm25 === r.pm25 && x.pm10 === r.pm10 && x.temperature === r.temperature);
    if (stuck) factors.push({ factor: "zero_variance", impact: "-", detail: `${tail.length} consecutive identical readings (PM2.5 ${r.pm25})` });

    // 4. Spatial consensus ---------------------------------------------------------------
    const relSelf = this.relOf(code, r, hour, means);
    const nbs = m.neighbors.map((n) => ({ ...n, latest: this.mem[n.code].latest }))
      .filter((n) => n.latest && t - n.latest.t < 180_000 && !["sensor_fault", "invalid"].includes(n.latest.status));
    const nbRel = median(nbs.map((n) => n.latest.rel));
    const elevated = (n) => n.latest.rel > 1.4 || (n.latest.rel > 1.25 && n.latest.excess > 6);
    const confirming = relSelf.rel > 1.45 ? nbs.filter(elevated) : [];
    const divergence = nbRel ? Math.abs(Math.log(relSelf.rel / nbRel)) : 0;
    let spatial = nbs.length ? clamp(100 - Math.max(0, divergence - 0.35) * 70) : 70;
    if (confirming.length) spatial = Math.max(spatial, confirming.length >= 2 ? 95 : 86);
    if (confirming.length) factors.push({ factor: "spatial_confirmation", impact: "+", detail: `Nearby ${confirming.map((n) => `${n.code} (${n.km.toFixed(1)} km)`).join(", ")} also elevated` });
    else if (nbs.length && divergence > 0.9) factors.push({ factor: "spatial_divergence", impact: "-", detail: `Diverges from ${nbs.length} neighbours (median relative level ${nbRel.toFixed(2)}×)` });

    // 5. Calibration drift: sensor / neighbour ratio vs its calibration-period ratio -----
    const nbPm = median(nbs.map((n) => n.latest.pm25));
    let drift = 1;
    const eventNearby = confirming.length > 0 || nbs.some((n) => n.latest.status === "anomalous");
    if (nbPm && !stuck && !eventNearby) {
      const lr = Math.log(r.pm25 / Math.max(nbPm, 3));
      const alpha = m.lastRatioT ? Math.min(0.05, (t - m.lastRatioT) / 240_000) : 0.05;
      m.lastRatioT = t;
      m.ratioEwma = m.ratioEwma == null ? lr : m.ratioEwma + alpha * (lr - m.ratioEwma);
      if (m.baselineRatio == null) {
        m.ratioSamples.push(lr);
        if (m.ratioSamples.length >= 300) m.baselineRatio = m.ratioSamples.reduce((a, b) => a + b, 0) / m.ratioSamples.length;
      }
    }
    if (m.baselineRatio != null && m.ratioEwma != null && !eventNearby) drift = Math.exp(m.ratioEwma - m.baselineRatio);
    const drifting = drift > config.driftThreshold;
    if (drifting) factors.push({ factor: "calibration_drift", impact: "-", detail: `Reads ${Math.round((drift - 1) * 100)}% above its calibrated relationship with neighbours` });

    // 6. Sensor health --------------------------------------------------------------------
    let health = 100;
    if (r.battery_level < 20) { health -= 20; factors.push({ factor: "low_battery", impact: "-", detail: `Battery ${r.battery_level}%` }); }
    if (r.signal_strength < -95) { health -= 15; factors.push({ factor: "weak_signal", impact: "-", detail: `Signal ${r.signal_strength} dBm` }); }
    if (drifting) health -= clamp((drift - config.driftThreshold) * 120, 15, 45);
    if (stuck) health = 0;

    // 7. Multivariate Isolation Forest ----------------------------------------------------
    const ifScore = this.forest.score(features(r));
    if (ifScore > 0.62) factors.push({ factor: "isolation_forest", impact: "-", detail: `Multivariate outlier (isolation score ${ifScore.toFixed(2)})` });

    // Scores --------------------------------------------------------------------------------
    const heat = r.temperature > 31 ? clamp((r.temperature - 31) * 12 + (r.wind_speed < 1 ? 30 : 0)) : 0;
    const pollutionAnomaly = clamp(0.4 * clamp(Math.max(0, Math.abs(z) - 1) * 18) + 0.3 * clamp(((ifScore - 0.5) / 0.25) * 100) + 0.3 * clamp((relSelf.rel - 1) * 55));
    const anomaly_score = Math.round(Math.max(pollutionAnomaly, heat, relSelf.rel > 2.2 ? 60 + Math.min(30, (relSelf.rel - 2.2) * 8) : 0));
    const w = config.confidenceWeights;
    let confidence_score = Math.round(w.temporal * temporal + w.spatial * spatial + w.physical * physical + w.health * health);
    if (stuck) confidence_score = Math.min(confidence_score, 30);
    if (violations.length) confidence_score = Math.min(confidence_score, 20);

    // Classification ---------------------------------------------------------------------
    let ai_status;
    if (violations.length) ai_status = "invalid";
    else if (stuck) ai_status = "sensor_fault";
    else if (anomaly_score >= 50) ai_status = (confirming.length || !nbs.length || heat >= 50) && confidence_score >= 55 ? "anomalous" : "suspicious";
    else if (drifting || confidence_score < 65) ai_status = "suspicious";
    else ai_status = "valid";

    const sev = worstLevel(r);
    const severity = ai_status === "anomalous" || ai_status === "valid" ? sev.level : ai_status === "sensor_fault" ? "maintenance" : sev.level;
    const windTo = (r.wind_direction + 180) % 360;
    const downwind = m.neighbors.filter((n) => angleDiff(n.bearing, windTo) < 50 && n.km < 8).map((n) => n.code);

    // Natural-language explanation -------------------------------------------------------
    const lp = relSelf.pollutant;
    const val = r[lp];
    const pct = Math.round((relSelf.rel - 1) * 100);
    let explanation;
    if (ai_status === "invalid") explanation = `Reading rejected: ${violations.join(", ")} outside physically possible limits. Excluded from all analyses.`;
    else if (ai_status === "sensor_fault") explanation = `${code} repeated identical values ${tail.length} times (zero variance). Firmware freeze suspected; readings excluded from official averages and a maintenance alert was raised.`;
    else if (ai_status === "anomalous" && heat >= 50) explanation = `Temperature ${r.temperature.toFixed(1)} °C with wind ${r.wind_speed.toFixed(1)} m/s at ${code}: stagnant hot air traps pollutants (O3 ${r.o3.toFixed(0)} µg/m³). Confidence ${confidence_score}%.`;
    else if (ai_status === "anomalous") explanation = `${LABEL[lp]} ${val.toFixed(1)} µg/m³ at ${code} (${m.sensor.district}), ${pct >= 0 ? "+" : ""}${pct}% vs the typical ${relSelf.typical.toFixed(1)} µg/m³ for ${hour}h (z = ${z.toFixed(1)}). ${confirming.length ? `Neighbours ${confirming.map((n) => n.code).join(", ")} confirm the pattern.` : "No neighbour data available to cross-check."} Wind ${r.wind_speed.toFixed(1)} m/s from ${compass(r.wind_direction)}${downwind.length ? `, dispersing toward ${downwind.join(", ")}` : ""}. Confidence ${confidence_score}%.`;
    else if (ai_status === "suspicious" && anomaly_score >= 50) explanation = `${LABEL[lp]} ${val.toFixed(1)} µg/m³ at ${code} is unusual (+${pct}%) but no neighbouring sensor confirms it${maDev > 1 ? " and the change is abrupt" : ""}. Likely a local glitch or very local source; held for review and excluded from official averages.`;
    else if (ai_status === "suspicious" && drifting) explanation = `${code} shows calibration drift: it now reads ${Math.round((drift - 1) * 100)}% higher than its calibrated relationship with neighbours. Recalibration recommended; readings flagged.`;
    else if (ai_status === "suspicious") explanation = `Low confidence (${confidence_score}%) for ${code}: ${factors.filter((f) => f.impact === "-").map((f) => f.detail).join("; ") || "weak corroboration"}.`;
    else explanation = `${code} within expected range: PM2.5 ${r.pm25.toFixed(1)} µg/m³ (typical ${relSelf.typical ? this.typical(code, "pm25", hour, mean).toFixed(1) : mean.toFixed(1)}), consistent with ${nbs.length} neighbours.`;

    const recommended_action = {
      invalid: "Discard reading and inspect device payload.",
      sensor_fault: "Dispatch maintenance; exclude device from official averages.",
      suspicious: drifting ? "Schedule co-location recalibration against a reference station." : "Hold for review; wait for corroboration.",
      anomalous: ["critical", "very_poor"].includes(sev.level) ? "Issue local public alert; advise sensitive groups to stay indoors." : sev.level === "poor" ? "Alert sensitive groups; increase monitoring frequency." : "Increase monitoring frequency.",
      valid: "No action required.",
    }[ai_status];

    const result = {
      ai_status, confidence_score, anomaly_score, severity, explanation, recommended_action,
      contributing_factors: factors,
      checks: {
        physical, temporal: Math.round(temporal), spatial: Math.round(spatial), health: Math.round(health),
        z_score: +z.toFixed(2), ma_deviation: +maDev.toFixed(2), isolation_score: +ifScore.toFixed(3),
        relative_level: +relSelf.rel.toFixed(2), lead_pollutant: lp, drift_factor: +drift.toFixed(2),
        neighbours_checked: nbs.map((n) => n.code), neighbours_confirming: confirming.map((n) => n.code),
        downwind_sensors: downwind, baseline_24h_pm25: +mean.toFixed(2),
      },
    };

    // Update memory ----------------------------------------------------------------------
    const rec = { t, pm25: r.pm25, pm10: r.pm10, no2: r.no2, o3: r.o3, temperature: r.temperature };
    m.raw.push(rec); if (m.raw.length > 40) m.raw.shift();
    if (ai_status === "valid" && relSelf.rel < 1.35 && !drifting) {
      m.hist.push(rec);
      // Hour-of-day profile: time-weighted EWMA so dense live data doesn't overwhelm 30 days of history.
      const alpha = m.lastProfileT ? 0.08 * Math.min(1, (t - m.lastProfileT) / 1_200_000) : 0.08;
      m.lastProfileT = t;
      for (const p of POLLUTANTS) {
        const cur = m.profile[p][hour];
        m.profile[p][hour] = cur == null ? r[p] : cur + alpha * (r[p] - cur);
      }
    }
    while (m.hist.length && m.hist[0].t < t - 864e5) m.hist.shift();
    m.latest = { t, rel: relSelf.rel, excess: r[relSelf.pollutant] - relSelf.typical, pm25: r.pm25, pm10: r.pm10, no2: r.no2, status: ai_status, confidence: confidence_score, anomaly: anomaly_score };
    return result;
  }
}

module.exports = { ClimateEngine, levelFor, worstLevel, LEVELS, POLLUTANTS, localHour };
