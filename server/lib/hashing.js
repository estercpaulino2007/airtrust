// Canonical payload normalisation + SHA-256. The SAME function is used when anchoring and
// when the public portal re-verifies, so any later change to a stored field breaks the proof.
const { sha256Hex } = require("./merkle");

const f2 = (v) => (v == null ? null : Number(v).toFixed(2));
const f5 = (v) => (v == null ? null : Number(v).toFixed(5));

function canonicalReading(r) {
  return JSON.stringify({
    v: 1,
    sensor: r.sensor_code,
    captured_at: r.captured_at,
    pm25: f2(r.pm25), pm10: f2(r.pm10), no2: f2(r.no2), o3: f2(r.o3),
    temperature: f2(r.temperature), humidity: f2(r.humidity),
    wind_speed: f2(r.wind_speed), wind_direction: f2(r.wind_direction),
  });
}

/** Fields frozen at verification time; later timeline updates (peak, end time) are not hashed. */
function canonicalEvent(e) {
  const list = (s) => (s ? JSON.parse(s) : []).slice().sort();
  return JSON.stringify({
    v: 1, code: e.code, title: e.title, type: e.type, severity: e.severity,
    latitude: f5(e.latitude), longitude: f5(e.longitude), started_at: e.started_at,
    sensors: list(e.sensor_codes), reports: list(e.report_codes),
    confidence: Number(e.confidence_score).toFixed(1), verified_at: e.verified_at,
  });
}

const hashReading = (r) => sha256Hex(canonicalReading(r));
const hashEvent = (e) => sha256Hex(canonicalEvent(e));

module.exports = { canonicalReading, canonicalEvent, hashReading, hashEvent };
