# Devpost submission — AirTrust

> Copy each section into the matching Devpost field.

## Project name
AirTrust — Climate Intelligence OS

## Elevator pitch (≤ 200 chars)
Verifiable air-quality intelligence: low-cost sensors + citizen reports, validated by explainable AI and sealed with blockchain proofs anyone can check.

## Track
**Climate Data & Environmental Monitoring** — "Enable reliable and accessible climate data systems. Environmental data is fragmented and difficult to verify."

AirTrust is a climate-data verification platform built on IoT environmental monitoring, with tools for research and insights:
- **Reliable:** every reading is validated by an explainable AI engine (7 detection methods, confidence score, spatial consensus).
- **Verifiable:** every reading is covered by a SHA-256 Merkle proof anchored on-chain; verified events get their own proofs; a public portal re-checks any record against the smart contract.
- **Accessible:** open REST API, Swagger docs, CSV/JSON exports where every row carries its AI status, confidence and proof.

## Inspiration
Air pollution is among the largest environmental health risks, and the WHO cut its PM2.5 annual guideline in half in 2021. Low-cost sensors could fill the huge gaps between expensive reference stations, but their data is rarely trusted: calibration drifts, devices freeze, values spike, and nobody can prove a record wasn't changed later. I wanted a system where a resident, a researcher and a city agency can all look at the same evidence and trust it.

## What it does
1. **Sense:** a mesh of 12 IoT sensors across Istanbul, on both sides of the Bosphorus (simulated in this prototype) streams PM2.5, PM10, NO₂, O₃, temperature, humidity, wind, battery and signal every 5 s. Residents submit reports (smoke, burning, dust, industrial, odor, traffic, heat).
2. **Understand:** an explainable AI engine checks every reading against physical limits, its own 24 h history (z-score, moving average), its 30-day hour-of-day profile, its neighbours (spatial consensus), a multivariate Isolation Forest, zero-variance (frozen firmware) and calibration drift. It outputs an **anomaly score**, a **confidence score**, a status and a plain-language explanation.
3. **Reason:** corroborated anomalies become **environmental events** (biomass smoke, industrial emission, dust, traffic, heatwave) classified from pollutant signatures and wind; citizen reports are correlated (0–100) by distance, timing, pollutant increase, wind and neighbour confirmation. Events are verified at ≥ 80% confidence or dismissed.
4. **Trust:** readings are hashed and anchored every 30 s as a Merkle root; verified events and their peak readings are anchored individually in `AirTrustLedger.sol`.
5. **Explain:** a *How it works* page, a 2-minute guided demo with one-click steps, and an embedded **AI assistant** that answers questions ("Is it safe to run in Beşiktaş?", "Why is AT-010 flagged?") in English, Turkish or Portuguese, grounded in live data (bring-your-own-key LLM such as Groq's free tier, with an offline mode that needs no key).
6. **Act:** critical alerts with recommended actions, 1/3/6 h forecasts, maintenance alerts for faulty sensors, and a **public verification portal** where anyone can confirm (or disprove) the integrity of any record.

## How I built it
- **Smart contract:** Solidity 0.8.24, Hardhat, ethers v6. Reading, event and Merkle batch proofs; on-chain `verifyBatchMembership()`; duplicate-hash protection; authorised submitters; events for every proof. Local Hardhat by default, Polygon Amoy ready.
- **Backend:** Node.js 22 HTTP API + WebSocket gateway, built-in SQLite, JWT (HS256) + scrypt, 5 roles, rate limiting, audit logs, OpenAPI 3 + Swagger UI.
- **AI:** implemented from scratch and tested: Isolation Forest, OLS forecasting with daily-cycle features and confidence intervals, spatial consensus, drift tracking, event reasoning and report correlation.
- **Front end:** dark mission-control command center (vanilla JS + Leaflet): live map with risk-colored pulsing sensors, pollution heat, wind and event overlays, AI agent activity feed, event timeline, trust-ledger cards, verification portal, scenario simulator, research API page, admin console, command palette (Ctrl K), light mode, keyboard and screen-reader support; risk is never shown by color alone.
- **Data:** 30 days of seeded history (≈26 000 readings) with 7 historical scenarios, 5 verified events, 25 citizen reports, 1 drifting sensor and 1 offline sensor, all labelled as simulated.

## Challenges I ran into
- **Separating "unusual" from "untrustworthy".** A single score couldn't tell a real smoke plume from a glitching sensor, so I split it into anomaly and confidence, and let spatial consensus decide.
- **Making the blockchain meaningful, not decorative.** One transaction per reading doesn't scale; Merkle batching keeps every reading provable with one transaction per batch, and the tamper demo shows exactly what the chain guarantees.
- **Freezing what gets hashed.** Events keep evolving after verification (peaks, end time), so I hash only fields frozen at verification time.

## Accomplishments I'm proud of
- End-to-end, running in one command: sensor → AI → event → citizen correlation → on-chain proof → alert → public verification.
- The integrity-failure demo: edit one value in the database and the portal immediately reports **Integrity check failed**.
- 22 automated tests (9 contract, 13 backend).
- Anyone can understand it in two minutes: the guided demo runs the whole story with one click per step, and the AI assistant answers questions about live data.

## What I learned
Trust in climate data is two problems: *is the measurement right?* (AI, calibration, consensus) and *is the record unchanged?* (cryptography). Neither alone is enough.

## What's next
Real sensor gateways and OpenAQ and Türkiye's national air-quality monitoring network reference stations for collaborative calibration; per-device signing keys; satellite fire/aerosol layers; SMS/push alerts and a mobile citizen app; city federation and a verifiable environmental-data marketplace; water, noise and urban-heat modules.

## Target users
Residents and community groups · schools and universities · environmental NGOs · city governments and agencies · researchers and data scientists · journalists and civic-tech groups.

## Scalability & adoption
- Sensors connect with one HTTP call (`POST /api/readings` + device key); thresholds are configurable per city.
- Merkle batching keeps on-chain cost flat as sensor counts grow.
- Residents report without technical knowledge (anonymous allowed, location rounded for privacy).
- Researchers get a documented API and exports; blockchain verification is optional and never blocks basic use.

## Built with
solidity · hardhat · groq · llm · ethers.js · node.js · sqlite · websocket · leaflet · javascript · openapi · swagger · machine-learning · isolation-forest · merkle-tree · polygon

## Links
- Repository: https://github.com/estercpaulino2007/airtrust
- Demo video: https://youtu.be/UFu0PNrAswI
