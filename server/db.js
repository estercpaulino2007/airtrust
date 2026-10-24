// SQLite persistence (Node's built-in node:sqlite). Schema mirrors the Prisma/Postgres model in the
// build brief; swapping to Postgres only means replacing this module.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

function open(file = config.dbFile) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS sensors (
      id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, latitude REAL, longitude REAL, district TEXT,
      profile TEXT, status TEXT, firmware_version TEXT, battery_level REAL, signal_strength REAL,
      installed_at TEXT, last_seen_at TEXT, health_score REAL DEFAULT 100);

    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY, sensor_id INTEGER, sensor_code TEXT,
      pm25 REAL, pm10 REAL, no2 REAL, o3 REAL, temperature REAL, humidity REAL,
      wind_speed REAL, wind_direction REAL, battery_level REAL, signal_strength REAL,
      captured_at TEXT, received_at TEXT,
      ai_status TEXT, confidence_score REAL, anomaly_score REAL, ai_explanation TEXT,
      data_hash TEXT, batch_id INTEGER, merkle_proof TEXT, tx_hash TEXT, block_number INTEGER, verified_at TEXT,
      simulated INTEGER DEFAULT 1);
    CREATE INDEX IF NOT EXISTS idx_readings_sensor_time ON readings(sensor_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_readings_time ON readings(captured_at);
    CREATE INDEX IF NOT EXISTS idx_readings_batch ON readings(batch_id);

    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY, merkle_root TEXT UNIQUE, reading_count INTEGER, from_time TEXT, to_time TEXT,
      tx_hash TEXT, block_number INTEGER, created_at TEXT);

    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY, reading_id INTEGER, sensor_id INTEGER, sensor_code TEXT, type TEXT, severity TEXT,
      description TEXT, ai_explanation TEXT, confidence_score REAL, anomaly_score REAL, contributing_factors TEXT,
      recommended_action TEXT, detected_at TEXT, resolved_at TEXT);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, sensor_id INTEGER, sensor_code TEXT, event_id INTEGER, pollutant TEXT, value REAL,
      threshold REAL, severity TEXT, message TEXT, recommendation TEXT, started_at TEXT, ended_at TEXT, status TEXT);

    CREATE TABLE IF NOT EXISTS citizen_reports (
      id INTEGER PRIMARY KEY, code TEXT, user_id INTEGER, type TEXT, description TEXT, latitude REAL, longitude REAL,
      severity TEXT, photo_url TEXT, created_at TEXT, ai_correlation_score REAL, correlation_status TEXT,
      correlation_explanation TEXT, related_sensor_ids TEXT, event_id INTEGER);

    CREATE TABLE IF NOT EXISTS environmental_events (
      id INTEGER PRIMARY KEY, code TEXT, title TEXT, type TEXT, severity TEXT, description TEXT, ai_explanation TEXT,
      latitude REAL, longitude REAL, district TEXT, started_at TEXT, ended_at TEXT, confidence_score REAL, status TEXT,
      sensor_codes TEXT, report_codes TEXT, peak_pm25 REAL, peak_pm10 REAL, timeline TEXT,
      data_hash TEXT, tx_hash TEXT, block_number INTEGER, verified_at TEXT);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT, role TEXT, created_at TEXT);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id TEXT, metadata TEXT, created_at TEXT);

    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT, duration_minutes REAL, status TEXT, config TEXT);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

module.exports = { open };
