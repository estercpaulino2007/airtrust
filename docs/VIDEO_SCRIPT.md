# Demo video script (≈ 4.5 min)

Tip: the in-app **guided demo** (welcome dialog → *Take the 2-minute guided demo*) performs every action below with one click per step, so you can focus on narrating.

Record at 1920×1080 with the browser full-screen. Before recording: `npm run reseed`, sign in as **admin**, open the Command Center and let it run ~1 min so the feed is populated. Keep the Citizen Signals tab ready with the default pin (İkitelli) and type **Smoke**.

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:25 | Boot animation → Command Center | "Air pollution kills millions every year, yet environmental data is fragmented and hard to trust. Official stations are few; low-cost sensors drift, freeze and can be tampered with. AirTrust is a Climate Intelligence OS that makes air-quality data reliable, explainable and verifiable." |
| 0:25–0:55 | Map, sensor list, telemetry bar | "Twelve sensors across Istanbul, on both sides of the Bosphorus, stream readings every five seconds. This is simulated data, labelled everywhere. Every reading passes through our AI engine: physical limits, z-score, moving average, a 30-day hourly profile, spatial consensus with neighbours, an Isolation Forest, stuck-value and drift detection." |
| 0:55–1:15 | Click AT-010 → drawer | "Already, the AI flagged AT-010: it reads 50% higher than its calibrated relationship with neighbours. Calibration drift: excluded from official averages, maintenance alert raised. Each reading gets two scores: is something unusual happening, and how much do we trust this sensor." |
| 1:15–1:30 | Scenario Simulator → Localized burning event | "Let's start a fire next to the İkitelli industrial zone." |
| 1:30–2:05 | Command Center: AT-007 rises, AI card, feed | "AT-007 jumps. At first the AI holds it for review: one sensor alone could be a glitch. Seconds later, Bağcılar and Başakşehir, downwind, confirm the plume. Now it's anomalous with 95% confidence, and the AI explains why: +280% versus typical for this hour, neighbours confirm, wind from the west." |
| 2:05–2:25 | Citizen Signals → send Smoke report | "A resident reports smoke. The AI correlates the report with the sensors: distance, timing, pollutant increase, wind. Strong correlation, 90 out of 100." |
| 2:25–2:50 | Command Center → event card + timeline + toast | "The reasoning layer creates a verified environmental event: biomass smoke plume, critical. Its evidence is hashed with SHA-256 and anchored on-chain, and a critical alert is issued. Full timeline: sensor reading, AI anomaly, spatial confirmation, citizen report, verification, blockchain proof, alert." |
| 2:50–3:30 | Verify → Use latest anomaly → Tamper → Restore | "Anyone can verify. The portal recomputes the hash from the stored data, walks the Merkle proof, and asks the smart contract. Verified. Now, an attacker with database access lowers the PM2.5 value to hide the pollution… Integrity check failed. The blockchain can't make a sensor accurate, that's the AI's job, but it guarantees nobody rewrites the evidence afterwards." |
| 3:30–3:45 | Trust Ledger | "Routine readings go on-chain as Merkle batches: one transaction covers hundreds of readings, each still individually provable. 99.9% of readings are covered." |
| 3:45–4:05 | Scenario → Faulty sensor (optional) → Research API | "Faulty sensors are caught too: a frozen device is flagged by zero variance. And researchers get an open API and exports where every row carries its AI status, confidence and proof." |
| 4:05–4:20 | ✦ Ask AirTrust AI → "Is it safe to run in İkitelli?" | "And anyone can just ask. The built-in assistant answers from live data, in English or Portuguese." |
| 4:20–4:35 | Command Center | "AirTrust: sensors measure, citizens observe, AI explains, blockchain preserves. Trusted climate data, accessible to everyone." |

Tips: zoom the browser to 110% so text is readable in the video; use OBS or the Windows Game Bar (Win+Alt+R); upload to YouTube as *Unlisted*.
