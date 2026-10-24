// Short-term forecasting (1h, 3h, 6h) for PM2.5, PM10 and temperature.
// Model = blend of (a) weighted moving average baseline and (b) ordinary least squares
// with time features: trend + daily cycle (sin/cos of hour) + neighbour mean.
// Confidence interval = 1.96 x residual std, widened with horizon.
const { levelFor, localHour } = require("./engine");

function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-9) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function ols(X, y, ridge = 1e-3) {
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  for (let a = 1; a < k; a++) XtX[a][a] += ridge;
  return solve(XtX, Xty);
}

/**
 * @param hourly  [{ t (ms, hour start), pm25, pm10, temperature, nb_pm25 }] sorted ascending (>= 12 points)
 * @param latest  latest raw reading of the sensor
 */
function forecastSensor(hourly, latest) {
  const now = Date.parse(latest.captured_at || latest.timestamp);
  const out = { generated_at: new Date(now).toISOString(), model: "WMA + OLS(trend, daily cycle, neighbour mean)", horizons: [] };
  if (hourly.length < 12) return { ...out, horizons: [], note: "Not enough history" };
  const t0 = hourly[0].t;
  const feats = (t, nb) => { const h = (localHour(t) / 24) * 2 * Math.PI; return [1, (t - t0) / 3.6e6, Math.sin(h), Math.cos(h), Math.sin(2 * h), Math.cos(2 * h), nb]; };

  for (const metric of ["pm25", "pm10", "temperature"]) {
    const rows = hourly.filter((r) => r[metric] != null);
    const nbKey = metric === "temperature" ? "temperature" : "nb_" + metric;
    const X = rows.map((r) => feats(r.t, r[nbKey] ?? r[metric]));
    const y = rows.map((r) => r[metric]);
    const beta = ols(X, y);
    const resid = beta ? y.map((v, i) => v - X[i].reduce((a, x, j) => a + x * beta[j], 0)) : y.map(() => 0);
    const sigma = Math.sqrt(resid.reduce((a, v) => a + v * v, 0) / Math.max(1, resid.length - X[0].length));
    const last3 = rows.slice(-3).map((r) => r[metric]);
    const wma = (last3[0] * 1 + (last3[1] ?? last3[0]) * 2 + (last3[2] ?? last3[0]) * 3) / 6;
    const current = latest[metric];
    const lastNb = rows[rows.length - 1][nbKey] ?? current;
    const slope = beta ? beta[1] : 0;

    for (const h of [1, 3, 6]) {
      const t = now + h * 3.6e6;
      const reg = beta ? feats(t, lastNb).reduce((a, x, j) => a + x * beta[j], 0) : wma;
      // Anomalous current state decays toward the model with a ~2h half-life.
      const persistence = Math.pow(0.5, h / 2);
      const wReg = h === 1 ? 0.5 : 0.75;
      let pred = (1 - persistence) * (wReg * reg + (1 - wReg) * wma) + persistence * current;
      if (metric !== "temperature") pred = Math.max(0, pred);
      const ci = 1.96 * sigma * Math.sqrt(1 + h / 3);
      const level = metric === "temperature" ? (pred >= 35 ? "very_poor" : pred >= 32 ? "poor" : "good") : levelFor(metric, pred);
      out.horizons.push({
        metric, horizon_hours: h, predicted: +pred.toFixed(2),
        lower: +Math.max(0, pred - ci).toFixed(2), upper: +(pred + ci).toFixed(2), risk_level: level,
      });
    }
    out[metric + "_explanation"] = `${metric.toUpperCase()} trend ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}/h over the last ${rows.length} h; daily-cycle model blended with recent moving average (${wma.toFixed(1)}). Residual σ ${sigma.toFixed(2)}.`;
  }
  const pm1 = out.horizons.find((x) => x.metric === "pm25" && x.horizon_hours === 1);
  const pm6 = out.horizons.find((x) => x.metric === "pm25" && x.horizon_hours === 6);
  out.explanation = `PM2.5 expected at ${pm1.predicted} µg/m³ in 1h (${pm1.risk_level.replace("_", " ")}) and ${pm6.predicted} µg/m³ in 6h (${pm6.risk_level.replace("_", " ")}). ${out.pm25_explanation}`;
  return out;
}

module.exports = { forecastSensor, ols };
