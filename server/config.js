// Central configuration. Every threshold is configurable per deployment (city, agency, sensor type).
const path = require("path");
const fs = require("fs");

// Load .env (KEY=value lines) so `npm run server` and `npm start` behave the same.
try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

module.exports = {
  port: Number(process.env.PORT || 4000),
  dbFile: process.env.DB_FILE || path.join(__dirname, "..", "data", "airtrust.db"),
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
  privateKey: process.env.LEDGER_PRIVATE_KEY || "", // empty -> first unlocked Hardhat account
  contractAddress: process.env.CONTRACT_ADDRESS || "",
  explorerTxUrl: process.env.EXPLORER_TX_URL || "", // e.g. https://amoy.polygonscan.com/tx/
  jwtSecret: process.env.JWT_SECRET || "airtrust-dev-secret-change-me",
  jwtTtlSeconds: 8 * 3600,
  tickMs: Number(process.env.TICK_MS || 5000),
  batchMs: Number(process.env.BATCH_MS || 30000),
  seedDays: Number(process.env.SEED_DAYS || 30),
  seedStepMinutes: 20,

  // Embedded AI assistant: bring-your-own-key. Without a key the assistant runs in offline mode
  // (rule-based answers grounded in live data). Groq's free tier works with the OpenAI format.
  assistant: {
    apiKey: process.env.ASSISTANT_API_KEY || "",
    format: (process.env.ASSISTANT_API_FORMAT || "openai").toLowerCase(), // "openai" | "anthropic"
    baseUrl: process.env.ASSISTANT_API_BASE_URL || "https://api.groq.com/openai",
    model: process.env.ASSISTANT_MODEL || "openai/gpt-oss-120b",
    maxTokens: Number(process.env.ASSISTANT_MAX_TOKENS || 900),
  },

  // Derived from WHO Global Air Quality Guidelines 2021 (24h guideline + interim targets).
  // Not a legal standard: configurable thresholds for the platform.
  thresholds: {
    pm25: [
      { level: "good", max: 15 },
      { level: "moderate", max: 25 },
      { level: "poor", max: 37.5 },
      { level: "very_poor", max: 75 },
      { level: "critical", max: Infinity },
    ],
    pm10: [
      { level: "good", max: 45 },
      { level: "moderate", max: 60 },
      { level: "poor", max: 90 },
      { level: "very_poor", max: 180 },
      { level: "critical", max: Infinity },
    ],
    no2: [
      { level: "good", max: 25 },
      { level: "moderate", max: 50 },
      { level: "poor", max: 100 },
      { level: "very_poor", max: 200 },
      { level: "critical", max: Infinity },
    ],
    o3: [
      { level: "good", max: 100 },
      { level: "moderate", max: 120 },
      { level: "poor", max: 160 },
      { level: "very_poor", max: 240 },
      { level: "critical", max: Infinity },
    ],
  },

  // Physically plausible ranges for low-cost sensors. Outside -> "invalid".
  physicalLimits: {
    pm25: [0, 1000], pm10: [0, 2000], no2: [0, 1000], o3: [0, 800],
    temperature: [-40, 60], humidity: [0, 100], wind_speed: [0, 60], wind_direction: [0, 360],
  },

  // Confidence weights (research dossier section 5.3).
  confidenceWeights: { temporal: 0.35, spatial: 0.30, physical: 0.20, health: 0.15 },
  neighborRadiusKm: 7,
  driftThreshold: 1.25,
};
