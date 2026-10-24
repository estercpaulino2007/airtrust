// OpenAPI 3 description served at /api/openapi.json and rendered by Swagger UI at /docs.html.
const op = (summary, tag, extra = {}) => ({ summary, tags: [tag], responses: { 200: { description: "OK" }, ...(extra.responses || {}) }, ...extra });
const idParam = (name, desc) => ({ name, in: "path", required: true, schema: { type: "string" }, description: desc });
const q = (name, desc, type = "string") => ({ name, in: "query", schema: { type }, description: desc });
const secured = { security: [{ bearer: [] }] };

module.exports = {
  openapi: "3.0.3",
  info: {
    title: "AirTrust — Climate Intelligence OS API",
    version: "2.0.0",
    description: "Open API for verifiable air-quality intelligence. All sensor data in this prototype is SIMULATED and labelled as such. " +
      "Readings are validated by an explainable AI engine and anchored on-chain via SHA-256 Merkle batches. Demo users: admin@ / operator@ / researcher@ / citizen@airtrust.demo, password AirTrust2026!",
    license: { name: "MIT" },
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" }, deviceKey: { type: "apiKey", in: "header", name: "X-Device-Key" } },
    schemas: {
      ReadingInput: {
        type: "object", required: ["sensor_id", "timestamp", "pm25", "pm10", "no2", "o3", "temperature", "humidity", "wind_speed", "wind_direction"],
        properties: {
          sensor_id: { type: "string", example: "AT-001" }, timestamp: { type: "string", format: "date-time" },
          pm25: { type: "number", example: 18.4 }, pm10: { type: "number", example: 32.1 }, no2: { type: "number", example: 21.7 }, o3: { type: "number", example: 34.2 },
          temperature: { type: "number", example: 24.6 }, humidity: { type: "number", example: 68.2 }, wind_speed: { type: "number", example: 2.4 },
          wind_direction: { type: "number", example: 180 }, battery_level: { type: "number", example: 87 }, signal_strength: { type: "number", example: -67 },
          firmware_version: { type: "string", example: "2.1.0" },
        },
      },
      ReportInput: {
        type: "object", required: ["type", "latitude", "longitude"],
        properties: {
          type: { type: "string", enum: ["smoke", "burning", "dust", "industrial", "odor", "traffic", "heat"] },
          latitude: { type: "number", example: -23.546 }, longitude: { type: "number", example: -46.744 },
          severity: { type: "string", enum: ["low", "medium", "high"] }, description: { type: "string", maxLength: 500 },
        },
      },
    },
  },
  paths: {
    "/api/health": { get: op("System health, ledger status", "System") },
    "/api/stats": { get: op("Live KPIs (readings/min, anomalies, alerts, verified events)", "System") },
    "/api/auth/login": { post: op("Obtain a JWT", "Auth", { requestBody: { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", example: "operator@airtrust.demo" }, password: { type: "string", example: "AirTrust2026!" } } } } } } }) },
    "/api/sensors": { get: op("List sensors with latest reading", "Sensors") },
    "/api/sensors/{id}": { get: op("Sensor detail", "Sensors", { parameters: [idParam("id", "Sensor code, e.g. AT-007")] }) },
    "/api/sensors/{id}/health": { get: op("Sensor health, calibration drift and neighbours", "Sensors", { parameters: [idParam("id", "Sensor code")] }) },
    "/api/sensors/{id}/history": { get: op("Aggregated history", "Sensors", { parameters: [idParam("id", "Sensor code"), q("hours", "Window in hours (max 720)", "integer")] }) },
    "/api/readings": {
      get: op("Query readings (pagination, filtering, sorting)", "Readings", { parameters: [q("sensor", "Sensor code"), q("status", "valid|suspicious|anomalous|invalid|sensor_fault"), q("from", "ISO date"), q("to", "ISO date"), q("sort", "captured_at|pm25|pm10|confidence_score|anomaly_score"), q("order", "asc|desc"), q("page", "Page", "integer"), q("limit", "Page size (max 1000)", "integer")] }),
      post: op("Ingest one or many readings (device key or operator JWT)", "Readings", { security: [{ deviceKey: [] }, { bearer: [] }], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ReadingInput" } } } } }),
    },
    "/api/readings/{id}": { get: op("Reading with AI explanation and Merkle proof", "Readings", { parameters: [idParam("id", "Reading id")] }) },
    "/api/anomalies": { get: op("AI anomaly log", "AI") },
    "/api/alerts": { get: op("Alerts", "AI", { parameters: [q("status", "active|resolved")] }) },
    "/api/forecasts/{sensorId}": { get: op("1h / 3h / 6h forecast for PM2.5, PM10 and temperature", "AI", { parameters: [idParam("sensorId", "Sensor code")] }) },
    "/api/events": { get: op("Environmental events", "Events") },
    "/api/events/{id}": { get: op("Event detail with timeline and reports", "Events", { parameters: [idParam("id", "Event id or code")] }) },
    "/api/reports": {
      get: op("Citizen reports with AI correlation", "Citizen"),
      post: op("Submit a citizen report (anonymous allowed; location rounded to ~110 m)", "Citizen", { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ReportInput" } } } } }),
    },
    "/api/blockchain/proofs": {
      get: op("Ledger status, Merkle batches, event and reading proofs", "Trust Ledger"),
      post: op("Anchor pending batch / a reading / an event (operator)", "Trust Ledger", { ...secured, requestBody: { content: { "application/json": { schema: { type: "object", properties: { reading_id: { type: "integer" }, event_id: { type: "integer" } } } } } } }),
    },
    "/api/verify/reading/{id}": { get: op("Public integrity verification of a reading (recompute SHA-256, Merkle proof, on-chain check)", "Verification", { parameters: [idParam("id", "Reading id")] }) },
    "/api/verify/event/{id}": { get: op("Public integrity verification of an event", "Verification", { parameters: [idParam("id", "Event id or code")] }) },
    "/api/scenarios": { get: op("Scenario catalogue", "Simulator") },
    "/api/scenarios/{scenarioId}/trigger": { post: op("Trigger a scenario (operator)", "Simulator", { ...secured, parameters: [idParam("scenarioId", "burning, industrial, dust, rush_hour, heatwave, sensor_fault, offline, drift, spike, gradual, recovery, normal")] }) },
    "/api/export/readings.csv": { get: op("Research export (CSV)", "Research", { parameters: [q("days", "1-30", "integer"), q("sensor", "Sensor code"), q("official", "true = only AI-trusted readings", "boolean")] }) },
    "/api/export/readings.json": { get: op("Research export (JSON)", "Research", { parameters: [q("days", "1-30", "integer"), q("sensor", "Sensor code"), q("official", "true = only AI-trusted readings", "boolean")] }) },
    "/api/admin/overview": { get: op("Users, thresholds, audit log (admin)", "Admin", secured) },
    "/api/admin/thresholds/{pollutant}": { put: op("Update thresholds (admin)", "Admin", { ...secured, parameters: [idParam("pollutant", "pm25|pm10|no2|o3")] }) },
    "/api/assistant/status": { get: op("Assistant mode (LLM provider or offline)", "Assistant") },
    "/api/assistant": { post: op("Ask the embedded AI assistant (answers grounded in live data)", "Assistant", { requestBody: { content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } } } } } } } } } }) },
    "/api/demo/tamper": { post: op("DEMO ONLY: edit a stored record to show integrity failure (admin)", "Demo", secured) },
  },
};
