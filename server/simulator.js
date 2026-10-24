// IoT sensor-mesh simulator. Produces physically plausible readings for São Paulo with diurnal
// cycles, rush hours and photochemical ozone, plus controllable scenarios for the demo.
// EVERYTHING produced here is simulated and stored with simulated = 1.
const SENSORS = require("./sensors");
const { distanceKm, bearingDeg } = require("./lib/geo");

const PROFILE_BASE = {
  urban: { pm25: 15, no2: 32 },
  traffic: { pm25: 20, no2: 48 },
  green: { pm25: 10, no2: 18 },
  industrial: { pm25: 19, no2: 38 },
};

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCENARIOS = [
  { id: "normal", name: "Normal urban baseline", type: "baseline", duration_minutes: 0,
    description: "Clears every active scenario and returns the mesh to its normal diurnal pattern." },
  { id: "rush_hour", name: "Rush-hour traffic", type: "traffic", duration_minutes: 4, center: "AT-002", radiusKm: 6,
    description: "NO2 and PM2.5 rise along Paulista Avenue and Marginal Tietê corridors." },
  { id: "burning", name: "Localized burning event", type: "wildfire_smoke", duration_minutes: 5, center: "AT-007", radiusKm: 3.2,
    description: "Biomass burning near Jaguaré. Smoke plume reaches Butantã (AT-004) and Lapa (AT-009)." },
  { id: "industrial", name: "Industrial smoke", type: "industrial_emission", duration_minutes: 4, center: "AT-008", radiusKm: 2.5,
    description: "Stack emission at Mooca rail yard: PM2.5 and NO2 spike together." },
  { id: "dust", name: "Dust storm", type: "dust_event", duration_minutes: 4, center: "AT-010", radiusKm: 3,
    description: "Strong winds lift coarse dust in the south zone: PM10 dominates PM2.5." },
  { id: "heatwave", name: "Heatwave with stagnant air", type: "heatwave", duration_minutes: 5, center: null,
    description: "City-wide temperature +9 °C, wind drops, ozone and PM accumulate." },
  { id: "sensor_fault", name: "Faulty sensor (stuck value)", type: "sensor_fault", duration_minutes: 4, center: "AT-012",
    description: "AT-012 freezes and repeats the same value. AI must flag zero variance." },
  { id: "offline", name: "Offline sensor", type: "sensor_fault", duration_minutes: 4, center: "AT-006",
    description: "AT-006 stops reporting (power/connectivity loss)." },
  { id: "drift", name: "Calibration drift", type: "sensor_fault", duration_minutes: 6, center: "AT-003",
    description: "AT-003 slowly over-reads PM2.5 relative to its neighbours." },
  { id: "spike", name: "Sudden isolated spike", type: "unknown_anomaly", duration_minutes: 0.3, center: "AT-005",
    description: "A single implausible PM2.5 burst with no neighbour confirmation (likely glitch)." },
  { id: "gradual", name: "Gradual pollution increase", type: "unknown_anomaly", duration_minutes: 6, center: "AT-001", radiusKm: 4,
    description: "Slow, steady accumulation downtown: tests trend-based detection." },
  { id: "recovery", name: "Recovery after event", type: "baseline", duration_minutes: 0,
    description: "Ends active scenarios with a smooth decay back to baseline." },
];

class Simulator {
  constructor({ seed } = {}) {
    this.rand = seed != null ? mulberry32(seed) : Math.random;
    this.sensors = SENSORS.map((s) => ({ ...s }));
    this.active = []; // { def, start, end, decayFrom? }
    this.state = new Map(this.sensors.map((s) => [s.code, {
      battery: 70 + this.rand() * 30, signal: -55 - this.rand() * 25, last: null,
      firmware: s.code === "AT-010" ? "2.0.3" : "2.1.0",
    }]));
    // Persistent background conditions for the live demo (dossier: one faulty + one offline sensor).
    // AT-010 started drifting 6 days ago (ramping over 2 days); AT-011 went offline 2 days ago.
    const now = Date.now();
    this.persistent = { driftStart: { "AT-010": now - 6 * 864e5 }, offlineSince: { "AT-011": now - 2 * 864e5 } };
  }

  gauss() { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = this.rand();
    while (v === 0) v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  listScenarios() {
    return SCENARIOS.map(({ id, name, type, duration_minutes, description, center }) => ({
      id, name, type, duration_minutes, description, center,
      status: this.active.some((a) => a.def.id === id) ? "running" : "idle",
    }));
  }

  trigger(id, now = Date.now()) {
    const def = SCENARIOS.find((s) => s.id === id);
    if (!def) throw Object.assign(new Error(`Unknown scenario ${id}`), { status: 404 });
    if (id === "normal") { this.active = []; return def; }
    if (id === "recovery") {
      for (const a of this.active) a.end = Math.min(a.end, now + 60_000), a.recovering = true;
      return def;
    }
    this.active = this.active.filter((a) => a.def.id !== id);
    this.active.push({ def, start: now, end: now + def.duration_minutes * 60_000 });
    return def;
  }

  /** Envelope 0..1: ramp-up over first 25%, plateau, ramp-down over last 20%. */
  envelope(a, now) {
    const dur = a.end - a.start;
    const p = (now - a.start) / dur;
    if (p < 0 || p > 1) return 0;
    if (p < 0.25) return p / 0.25;
    if (p > 0.8) return (1 - p) / 0.2;
    return 1;
  }

  baseline(sensor, t, st) {
    const d = new Date(t);
    const h = d.getUTCHours() - 3 + d.getUTCMinutes() / 60; // São Paulo local time (UTC-3)
    const hour = (h + 24) % 24;
    const dow = d.getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.78 : 1;
    const base = PROFILE_BASE[sensor.profile];
    const rush = Math.exp(-((hour - 8) ** 2) / 2.5) + 0.9 * Math.exp(-((hour - 18.5) ** 2) / 3);
    const night = 0.2 * Math.exp(-((hour - 1) ** 2) / 6); // inversion layer at night
    const sun = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));

    const temperature = 19 + 7 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + this.gauss() * 0.4;
    const humidity = Math.min(98, Math.max(25, 72 - (temperature - 19) * 3 + this.gauss() * 2));
    const wind_speed = Math.max(0.2, 2.4 + 1.2 * sun + this.gauss() * 0.5);
    const wind_direction = (135 + 25 * Math.sin(t / 3.6e6) + this.gauss() * 10 + 360) % 360; // SE sea breeze

    const pm25 = Math.max(2, base.pm25 * weekend * (1 + 0.55 * rush + night) * (1 - 0.06 * (wind_speed - 2.4)) + this.gauss() * 1.6);
    const pm10 = Math.max(4, pm25 * (1.65 + 0.15 * this.rand()) + this.gauss() * 2);
    const no2 = Math.max(3, base.no2 * weekend * (1 + 0.8 * rush) * (1 - 0.35 * sun) + this.gauss() * 3);
    const o3 = Math.max(5, 25 + 70 * sun * (1 - no2 / 250) + this.gauss() * 4);
    return { pm25, pm10, no2, o3, temperature, humidity, wind_speed, wind_direction };
  }

  applyScenarios(sensor, r, now) {
    const center = (code) => this.sensors.find((s) => s.code === code);
    for (const a of this.active) {
      const k = this.envelope(a, now);
      if (k <= 0) continue;
      const def = a.def;
      const c = def.center ? center(def.center) : null;
      const dist = c ? distanceKm(c, sensor) : 0;
      const w = c ? Math.exp(-dist / (def.radiusKm || 3)) : 1;
      switch (def.id) {
        case "burning": {
          // Plume follows the wind: sensors downwind of the fire get more smoke.
          r.wind_direction = 260 + this.gauss() * 6; // westerly wind pushing smoke east
          r.wind_speed = 2.1 + this.gauss() * 0.2;
          const toSensor = c ? bearingDeg(c, sensor) : 0;
          const downwind = (r.wind_direction + 180) % 360;
          const align = dist < 0.1 ? 1 : 0.55 + 0.45 * Math.cos(((toSensor - downwind) * Math.PI) / 180);
          const add = 78 * k * w * align;
          r.pm25 += add; r.pm10 += add * 1.35; r.no2 += 6 * k * w;
          break;
        }
        case "industrial": r.pm25 += 45 * k * w; r.pm10 += 55 * k * w; r.no2 += 110 * k * w; break;
        case "dust": r.pm10 += 165 * k * w; r.pm25 += 22 * k * w; r.wind_speed = Math.max(r.wind_speed, 8 + 3 * k * w); break;
        case "rush_hour": {
          const t2 = center("AT-006");
          const w2 = Math.max(w, Math.exp(-distanceKm(t2, sensor) / 4));
          r.no2 += 85 * k * w2; r.pm25 += 16 * k * w2; r.pm10 += 22 * k * w2; break;
        }
        case "heatwave":
          r.temperature += 9 * k; r.humidity = Math.max(18, r.humidity - 22 * k);
          r.wind_speed = Math.max(0.1, r.wind_speed * (1 - 0.85 * k)); r.o3 += 75 * k; r.pm25 += 11 * k; r.pm10 += 14 * k; break;
        case "gradual": {
          const p = Math.min(1, (now - a.start) / (a.end - a.start - 60_000));
          r.pm25 += 48 * p * w * (a.recovering ? k : 1); r.pm10 += 60 * p * w * (a.recovering ? k : 1); break;
        }
        case "spike": if (sensor.code === def.center) { r.pm25 = 380 + this.rand() * 40; r.pm10 = r.pm10 * 1.1; } break;
        case "drift": if (sensor.code === def.center) r.pm25 *= 1 + 0.9 * Math.min(1, (now - a.start) / ((a.end - a.start) * 0.7)); break;
        default: break;
      }
    }
    return r;
  }

  isOffline(code, now) {
    const since = this.persistent.offlineSince[code];
    if (since && now >= since) return true;
    return this.active.some((a) => a.def.id === "offline" && a.def.center === code && now >= a.start && now <= a.end);
  }

  isStuck(code, now) {
    return this.active.some((a) => a.def.id === "sensor_fault" && a.def.center === code && now >= a.start && now <= a.end);
  }

  /** One reading per online sensor at time `now`. */
  tick(now = Date.now(), { includeScenarios = true } = {}) {
    this.active = this.active.filter((a) => now <= a.end);
    const out = [];
    for (const s of this.sensors) {
      const st = this.state.get(s.code);
      if (this.isOffline(s.code, now)) continue;
      let r;
      if (this.isStuck(s.code, now) && st.last) {
        r = { ...st.last }; // frozen firmware: exact repeat of last values
      } else {
        r = this.baseline(s, now, st);
        if (includeScenarios) this.applyScenarios(s, r, now);
        const ds = this.persistent.driftStart[s.code];
        if (ds && now > ds) r.pm25 *= 1 + 0.55 * Math.min(1, (now - ds) / (2 * 864e5)); // slow calibration drift
      }
      st.battery = Math.min(100, Math.max(5, st.battery - 0.002 + (this.rand() < 0.001 ? 40 : 0)));
      st.signal = Math.max(-110, Math.min(-45, st.signal + this.gauss() * 1.2));
      const reading = {
        sensor_id: s.code, latitude: s.latitude, longitude: s.longitude, district: s.district,
        timestamp: new Date(now).toISOString(),
        pm25: +r.pm25.toFixed(2), pm10: +r.pm10.toFixed(2), no2: +r.no2.toFixed(2), o3: +r.o3.toFixed(2),
        temperature: +r.temperature.toFixed(2), humidity: +r.humidity.toFixed(2),
        wind_speed: +r.wind_speed.toFixed(2), wind_direction: Math.round(r.wind_direction) % 360,
        battery_level: Math.round(st.battery), signal_strength: Math.round(st.signal),
        status: "online", firmware_version: st.firmware,
      };
      if (!this.isStuck(s.code, now)) st.last = r;
      out.push(reading);
    }
    return out;
  }
}

module.exports = { Simulator, SCENARIOS, mulberry32 };
