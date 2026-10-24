// Embedded "Ask AirTrust" assistant.
//
// Two modes:
//   1. LLM mode (bring-your-own-key): Groq free tier (OpenAI format) or Anthropic. The model gets a
//      compact snapshot of LIVE platform data and must answer only from it.
//   2. Offline mode (no key, or provider error): a deterministic, bilingual (EN/PT) assistant that
//      answers from the same live snapshot. Nothing is invented: every number comes from the DB.
const config = require("../config");
const { levelFor } = require("./engine");

const GUIDE = {
  howitworks: { en: "How it works — what AirTrust is, the 5-step pipeline, what each tab does, glossary and the guided demo.", pt: "How it works — o que é o AirTrust, o fluxo em 5 etapas, o que faz cada aba, glossário e a demo guiada." },
  command: { en: "Command Center — live map of the 12 sensors, colored by risk. Left: sensor list and pollutant filter. Right: AI assessment, active event and the AI activity feed. Click a sensor for details and forecast.", pt: "Command Center — mapa ao vivo dos 12 sensores, coloridos por risco. Esquerda: lista de sensores e filtro de poluente. Direita: avaliação da IA, evento ativo e o feed de atividade da IA. Clique num sensor para ver detalhes e previsão." },
  events: { en: "Events — pollution episodes the AI confirmed (or dismissed), with timeline, sensors, citizen reports and the blockchain proof.", pt: "Events — episódios de poluição que a IA confirmou (ou descartou), com linha do tempo, sensores, relatos de cidadãos e a prova na blockchain." },
  alerts: { en: "Alerts — public-health alerts from verified events and maintenance alerts (frozen sensor, calibration drift, offline).", pt: "Alerts — alertas de saúde pública dos eventos verificados e alertas de manutenção (sensor travado, descalibrado, offline)." },
  citizens: { en: "Citizen Signals — anyone can report smoke, dust, odor, traffic or heat on the map; the AI scores how well each report matches nearby sensors (0–100).", pt: "Citizen Signals — qualquer pessoa reporta fumaça, poeira, odor, trânsito ou calor no mapa; a IA dá uma nota de 0 a 100 de quanto o relato bate com os sensores próximos." },
  ledger: { en: "Trust Ledger — what is recorded on the blockchain: Merkle batches of readings, event proofs and critical reading proofs.", pt: "Trust Ledger — o que está gravado na blockchain: lotes Merkle de leituras, provas de eventos e provas de leituras críticas." },
  verify: { en: "Verify — public portal: recomputes the SHA-256 fingerprint of a record and asks the smart contract if it matches. Admins can run the tamper demo.", pt: "Verify — portal público: recalcula a impressão digital SHA-256 de um registro e pergunta ao contrato se bate. O admin pode rodar a demo de adulteração." },
  simulator: { en: "Scenario Simulator — injects controlled events (fire, industrial smoke, dust, heatwave, faulty sensor…) to test how the AI reacts. Needs operator or admin.", pt: "Scenario Simulator — injeta eventos controlados (queimada, fumaça industrial, poeira, onda de calor, sensor com defeito…) para testar a reação da IA. Precisa de operador ou admin." },
  research: { en: "Research API — open REST API with Swagger docs and CSV/JSON exports where every row has its AI status, confidence and proof.", pt: "Research API — API REST aberta com documentação Swagger e exportação CSV/JSON em que cada linha traz status da IA, confiança e prova." },
  admin: { en: "Admin — sensors, users and roles, configurable thresholds, system health and the audit log.", pt: "Admin — sensores, usuários e papéis, limites configuráveis, saúde do sistema e log de auditoria." },
};

const GLOSSARY = {
  pm25: { en: "PM2.5: fine particles ≤ 2.5 µm (smoke, combustion). They reach deep into the lungs and blood. WHO 24 h guideline: 15 µg/m³.", pt: "PM2.5: partículas finas ≤ 2,5 µm (fumaça, combustão). Chegam fundo nos pulmões e no sangue. Diretriz da OMS em 24 h: 15 µg/m³." },
  pm10: { en: "PM10: inhalable particles ≤ 10 µm (dust, construction, traffic). WHO 24 h guideline: 45 µg/m³.", pt: "PM10: partículas inaláveis ≤ 10 µm (poeira, obras, trânsito). Diretriz da OMS em 24 h: 45 µg/m³." },
  no2: { en: "NO₂: nitrogen dioxide, mostly from vehicles and combustion; irritates airways. WHO 24 h guideline: 25 µg/m³.", pt: "NO₂: dióxido de nitrogênio, vem principalmente de veículos e combustão; irrita as vias respiratórias. Diretriz da OMS em 24 h: 25 µg/m³." },
  o3: { en: "O₃: ground-level ozone, formed by sunlight acting on pollutants; peaks in the afternoon. WHO 8 h guideline: 100 µg/m³.", pt: "O₃: ozônio troposférico, formado pela luz do sol sobre poluentes; pico à tarde. Diretriz da OMS em 8 h: 100 µg/m³." },
  confidence: { en: "Confidence score (0–100): how much we trust a measurement = 35% temporal consistency + 30% agreement with neighbours + 20% physical validity + 15% sensor health.", pt: "Confidence score (0–100): o quanto confiamos na medição = 35% consistência no tempo + 30% concordância com vizinhos + 20% validade física + 15% saúde do sensor." },
  anomaly: { en: "Anomaly score (0–100): how unusual the air is compared with this sensor's history, its typical value for this hour and a multivariate Isolation Forest. High anomaly + high confidence = real pollution event; high anomaly + low confidence = probable glitch.", pt: "Anomaly score (0–100): o quanto o ar está fora do normal comparado ao histórico do sensor, ao valor típico da hora e a uma Isolation Forest. Anomalia alta + confiança alta = poluição real; anomalia alta + confiança baixa = provável defeito." },
  drift: { en: "Calibration drift: a sensor slowly starts over- or under-reading. AirTrust compares each sensor with its neighbours against the ratio it had when calibrated; above 1.25× it is flagged for recalibration.", pt: "Descalibração (drift): o sensor começa a medir a mais ou a menos aos poucos. O AirTrust compara cada sensor com os vizinhos contra a proporção que tinha quando calibrado; acima de 1,25× ele é marcado para recalibrar." },
  blockchain: { en: "Blockchain proofs: AirTrust never puts raw data on-chain, only SHA-256 fingerprints. Every 30 s all new readings are combined into one Merkle root (one transaction, each reading still provable). Verified events and their peak readings get individual proofs. If anyone later edits the database, the recomputed fingerprint no longer matches and verification fails.", pt: "Provas na blockchain: o AirTrust nunca grava dados brutos na blockchain, só impressões digitais SHA-256. A cada 30 s todas as leituras novas viram uma raiz Merkle (uma transação, cada leitura continua comprovável). Eventos verificados e suas leituras de pico ganham provas individuais. Se alguém editar o banco depois, a impressão recalculada não bate e a verificação falha." },
  simulated: { en: "All sensor data in this prototype is simulated (12 virtual sensors at real São Paulo locations) and labelled as such. Real gateways can send data to POST /api/readings.", pt: "Todos os dados de sensores deste protótipo são simulados (12 sensores virtuais em locais reais de São Paulo) e rotulados assim. Gateways reais podem enviar dados para POST /api/readings." },
};

const ADVICE = {
  good: { en: "Air quality is good: normal outdoor activity is fine.", pt: "Qualidade do ar boa: atividades ao ar livre normais estão liberadas." },
  moderate: { en: "Moderate: acceptable for most people; unusually sensitive people may reduce long, intense outdoor exercise.", pt: "Moderada: aceitável para a maioria; pessoas muito sensíveis podem reduzir exercícios longos e intensos ao ar livre." },
  poor: { en: "Poor: sensitive groups (children, older adults, people with asthma or heart disease) should reduce outdoor exertion.", pt: "Ruim: grupos sensíveis (crianças, idosos, pessoas com asma ou doenças do coração) devem reduzir esforço ao ar livre." },
  very_poor: { en: "Very poor: everyone should reduce outdoor exertion; sensitive groups should stay indoors with windows closed.", pt: "Muito ruim: todos devem reduzir esforço ao ar livre; grupos sensíveis devem ficar em casa com janelas fechadas." },
  critical: { en: "Critical: avoid outdoor activity, close windows, and follow local authority guidance.", pt: "Crítica: evite atividades ao ar livre, feche as janelas e siga as orientações das autoridades locais." },
};

const LEVEL_RANK = { good: 0, moderate: 1, poor: 2, very_poor: 3, critical: 4 };
const lvlName = { en: { good: "good", moderate: "moderate", poor: "poor", very_poor: "very poor", critical: "critical" }, pt: { good: "boa", moderate: "moderada", poor: "ruim", very_poor: "muito ruim", critical: "crítica" } };
const statusName = { en: { valid: "valid", anomalous: "anomalous (confirmed)", suspicious: "held for review", sensor_fault: "sensor fault", invalid: "invalid" }, pt: { valid: "válida", anomalous: "anômala (confirmada)", suspicious: "em revisão", sensor_fault: "defeito no sensor", invalid: "inválida" } };

// ----------------------------------------------------------------------------- snapshot
function snapshot(core, db, ledgerStatus) {
  const since = new Date(Date.now() - 3 * 60_000).toISOString();
  const sensors = core.sensors.map((s) => {
    const r = db.prepare("SELECT * FROM readings WHERE sensor_code=? ORDER BY captured_at DESC LIMIT 1").get(s.code);
    const fresh = r && r.captured_at >= since;
    let ex = {};
    try { ex = r ? JSON.parse(r.ai_explanation || "{}") : {}; } catch {}
    const lvl = r ? ["pm25", "pm10", "no2", "o3"].map((p) => levelFor(p, r[p])).sort((a, b) => LEVEL_RANK[b] - LEVEL_RANK[a])[0] : null;
    return {
      code: s.code, name: s.name, district: s.district, status: fresh ? s.status : "offline",
      pm25: r?.pm25, pm10: r?.pm10, no2: r?.no2, o3: r?.o3, temperature: r?.temperature, wind_speed: r?.wind_speed,
      ai_status: fresh ? r.ai_status : null, confidence: fresh ? r.confidence_score : null, anomaly: fresh ? r.anomaly_score : null,
      level: fresh ? lvl : null, explanation: fresh ? ex.explanation : null, drift: ex.checks?.drift_factor ?? null, last_seen: r?.captured_at,
    };
  });
  const events = db.prepare("SELECT code, title, type, severity, status, confidence_score, sensor_codes, report_codes, started_at, ended_at, block_number FROM environmental_events ORDER BY started_at DESC LIMIT 8").all()
    .map((e) => ({ ...e, sensor_codes: JSON.parse(e.sensor_codes || "[]"), report_codes: JSON.parse(e.report_codes || "[]"), active: !e.ended_at }));
  const alerts = db.prepare("SELECT severity, message, recommendation, started_at FROM alerts WHERE status='active' ORDER BY started_at DESC LIMIT 8").all();
  const reports = db.prepare("SELECT code, type, description, ai_correlation_score, correlation_status, created_at FROM citizen_reports ORDER BY created_at DESC LIMIT 5").all();
  const anchored = db.prepare("SELECT COUNT(*) n FROM readings WHERE batch_id IS NOT NULL").get().n;
  const total = db.prepare("SELECT COUNT(*) n FROM readings").get().n;
  const scenarios = core.sim.listScenarios().filter((s) => s.status === "running").map((s) => s.name);
  return { at: new Date().toISOString(), sensors, events, alerts, reports, ledger: ledgerStatus, anchored, total, scenarios };
}

function contextText(snap) {
  const f = (v, d = 1) => (v == null ? "n/a" : Number(v).toFixed(d));
  const lines = [];
  lines.push(`Snapshot time (UTC): ${snap.at}. City: São Paulo (pilot). ALL SENSOR DATA IS SIMULATED.`);
  lines.push(`Running scenarios: ${snap.scenarios.join(", ") || "none"}.`);
  lines.push("SENSORS (code | district | status | PM2.5 | PM10 | NO2 | O3 µg/m³ | temp °C | AI status | confidence | anomaly | risk level | AI explanation):");
  for (const s of snap.sensors) lines.push(`- ${s.code} | ${s.district} (${s.name}) | ${s.status} | ${f(s.pm25)} | ${f(s.pm10)} | ${f(s.no2, 0)} | ${f(s.o3, 0)} | ${f(s.temperature)} | ${s.ai_status ?? "no live data"} | ${s.confidence ?? "-"} | ${s.anomaly ?? "-"} | ${s.level ?? "-"} | ${s.explanation ?? ""}`);
  lines.push("RECENT EVENTS:");
  for (const e of snap.events) lines.push(`- ${e.code} ${e.title} | ${e.type} | ${e.severity} | ${e.status}${e.active ? " (ONGOING)" : ""} | confidence ${f(e.confidence_score, 0)}% | sensors ${e.sensor_codes.join(",")} | reports ${e.report_codes.join(",") || "none"} | started ${e.started_at}${e.block_number ? ` | on-chain block #${e.block_number}` : ""}`);
  lines.push("ACTIVE ALERTS:");
  for (const a of snap.alerts) lines.push(`- [${a.severity}] ${a.message} — ${a.recommendation}`);
  if (!snap.alerts.length) lines.push("- none");
  lines.push("LATEST CITIZEN REPORTS:");
  for (const r of snap.reports) lines.push(`- ${r.code} ${r.type} "${(r.description || "").slice(0, 80)}" correlation ${r.ai_correlation_score}/100 (${r.correlation_status})`);
  lines.push(`LEDGER: ${snap.ledger?.connected ? `connected to ${snap.ledger.network?.name}, contract ${snap.ledger.contract}, block #${snap.ledger.block}, ${snap.ledger.totals?.batches} Merkle batches, ${snap.ledger.totals?.events} event proofs, ${snap.ledger.totals?.readings} reading proofs` : "offline"}. Readings covered by on-chain proofs: ${snap.anchored}/${snap.total}.`);
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are "AirTrust AI", the assistant embedded in AirTrust, a Climate Intelligence OS for verifiable air-quality monitoring (IEEE ClimateChain Global Hackathon 2026 prototype).

How AirTrust works: (1) 12 low-cost IoT sensors in São Paulo send PM2.5, PM10, NO2, O3, temperature, humidity and wind every 5 s — SIMULATED in this prototype. (2) An explainable AI checks every reading (physical limits, z-score vs 24 h history, moving average, typical value for the hour, spatial consensus with neighbours, Isolation Forest, stuck-value and calibration-drift detection) and gives an anomaly score and a confidence score. (3) Citizens report smoke/dust/odor/traffic/heat; the AI scores each report 0–100 against nearby sensors. (4) Corroborated anomalies become environmental events; an event is verified at ≥80% confidence, hashed with SHA-256, anchored on a blockchain (AirTrustLedger.sol) and a public alert is issued. (5) Anyone can verify a record in the Verify tab: the portal recomputes the hash and asks the smart contract; edited records fail.

Tabs: ${Object.values(GUIDE).map((g) => g.en).join(" ")}

Thresholds (WHO 2021 derived, configurable): PM2.5 good ≤15, moderate ≤25, poor ≤37.5, very poor ≤75, critical >75 µg/m³. PM10 good ≤45, moderate ≤60, poor ≤90, very poor ≤180.

Rules:
- Answer ONLY from the LIVE DATA below and the description above. Never invent sensors, numbers, places or events. If the data does not contain the answer, say so.
- Always remind that sensor data is simulated when giving health-related answers, and give general guidance only (not medical advice).
- Reply in the same language the user writes in (Portuguese or English). Be concise: short paragraphs or bullet points, max ~180 words unless asked for detail.
- When useful, tell the user which tab to open or which button to click.`;

// ---------------------------------------------------------------------------- LLM mode
async function askLLM(messages, ctx) {
  const a = config.assistant;
  const system = `${SYSTEM_PROMPT}\n\nLIVE DATA:\n${ctx}`;
  const hist = messages.slice(-10).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000) }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    if (a.format === "anthropic") {
      const res = await fetch(`${a.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-api-key": a.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: a.model, max_tokens: a.maxTokens, system, messages: hist }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error?.message || `HTTP ${res.status}`);
      return d.content.map((c) => c.text || "").join("").trim();
    }
    const res = await fetch(`${a.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ model: a.model, max_tokens: a.maxTokens, temperature: 0.3, messages: [{ role: "system", content: system }, ...hist] }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error?.message || `HTTP ${res.status}`);
    return (d.choices?.[0]?.message?.content || "").trim();
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------------ offline mode
const PT_HINT = /[ãõçáéíóúâêô]|\b(o que|qual|quais|como|onde|est[aá]|agora|ar |seguro|posso|correr|sensor(es)? |evento|alerta|aba|explica|funciona|para que|por ?que|hoje|bairro|previs[aã]o|ajuda|oi|ol[aá])\b/i;
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function localAnswer(question, snap) {
  // Place names (Jaguaré, Butantã, São Paulo…) contain accents, so remove them before guessing the language.
  let bare = question.replace(/s[ãa]o paulo/gi, "");
  for (const s of snap.sensors) for (const w of `${s.district} ${s.name}`.split(/\s+/)) if (w.length > 3) bare = bare.split(w).join("");
  const pt = PT_HINT.test(bare);
  const L = pt ? "pt" : "en";
  const t = (en, ptx) => (pt ? ptx : en);
  const q = norm(question);
  const f = (v, d = 1) => (v == null ? "–" : Number(v).toFixed(d));
  const live = snap.sensors.filter((s) => s.ai_status);
  const sensorLine = (s) => `**${s.code} · ${s.district}**: PM2.5 ${f(s.pm25)} µg/m³, PM10 ${f(s.pm10)}, NO₂ ${f(s.no2, 0)} · ${t("air", "ar")} **${lvlName[L][s.level] || "–"}** · ${t("AI", "IA")}: ${statusName[L][s.ai_status] || t("no live data", "sem dados ao vivo")}${s.confidence != null ? ` (${t("confidence", "confiança")} ${s.confidence}%)` : ""}`;
  const disclaimer = t("_Simulated data · general guidance, not medical advice._", "_Dados simulados · orientação geral, não é aconselhamento médico._");

  // Specific sensor or district
  const byCode = snap.sensors.find((s) => q.includes(s.code.toLowerCase()) || q.includes(s.code.toLowerCase().replace("-", "")));
  const byDistrict = snap.sensors.find((s) => q.includes(norm(s.district)) || norm(s.name).split(" ").some((w) => w.length > 4 && q.includes(w)));
  const sensor = byCode || byDistrict;

  // Glossary
  const gloss = [
    [/pm ?2[.,]?5/, "pm25"], [/pm ?10/, "pm10"], [/\bno2\b|dioxido|nitrogen/, "no2"], [/\bo3\b|ozon/, "o3"],
    [/confian|confidence/, "confidence"], [/anomal/, "anomaly"], [/drift|descalibr|calibra/, "drift"],
    [/blockchain|hash|merkle|contrato|contract|ledger|integridade|integrity|adulter|tamper|verific|verify/, "blockchain"],
    [/simulad|simulated|real data|dados reais|fake|falso/, "simulated"],
  ];
  const isWhat = /o que (e|eh|significa|quer dizer)|what (is|does|are)|significa|explain|explica|meaning|como funciona|how does/.test(q);

  // Tabs
  const tabMap = [
    [/how it works|guia|guide/, "howitworks"], [/command|mapa|map/, "command"], [/event/, "events"], [/alert/, "alerts"],
    [/citizen|cidad|relat|report/, "citizens"], [/ledger/, "ledger"], [/verify|verific/, "verify"], [/simulat|cenari|scenario/, "simulator"],
    [/research|api|export|pesquis/, "research"], [/admin/, "admin"],
  ];

  if (/\b(aba|abas|tab|tabs|menu)\b/.test(q) && /cada|each|all|todas|quais|what|o que/.test(q))
    return t("Here is what each tab does:\n", "O que cada aba faz:\n") + Object.values(GUIDE).map((g) => `- ${g[L]}`).join("\n");

  if (/como (eu )?(uso|usar|utiliz|comec)|how (do i|to) (use|start)|demo|tutorial|passo a passo|step by step|por onde comec/.test(q))
    return t(
      "Quickest way: open **How it works** and click **Start guided demo**. It walks you through it:\n1. Look at the map: each dot is a sensor, colored by risk.\n2. Start a fire (Scenario Simulator → Localized burning event).\n3. Watch the AI confirm it with neighbouring sensors.\n4. Send a citizen smoke report.\n5. See the event verified and anchored on the blockchain.\n6. Verify a record, then tamper with it and watch verification fail.",
      "O jeito mais rápido: abra **How it works** e clique em **Start guided demo**. Ela conduz passo a passo:\n1. Veja o mapa: cada ponto é um sensor, colorido pelo risco.\n2. Inicie uma queimada (Scenario Simulator → Localized burning event).\n3. Veja a IA confirmar com os sensores vizinhos.\n4. Envie um relato cidadão de fumaça.\n5. Veja o evento ser verificado e gravado na blockchain.\n6. Verifique um registro, depois adultere e veja a verificação falhar.");

  if (sensor && /why|por ?que|motivo|reason|flag|marcad|suspeit|suspicious|drift|descalibr|status|como esta|how is|what about|e o |detalhe|detail/.test(q))
    return `${sensorLine(sensor)}${sensor.explanation ? `\n\n${t("AI explanation", "Explicação da IA")}: ${sensor.explanation}` : ""}${sensor.drift > 1.25 ? t(`\n\nCalibration drift ×${sensor.drift}: recalibration recommended.`, `\n\nDescalibração ×${sensor.drift}: recomendada recalibração.`) : ""}`;

  if (/para que serve|what is airtrust|o que e (o )?airtrust|what does airtrust|objetivo|purpose/.test(q))
    return t(
      "**AirTrust** makes air-quality data **trustworthy**. Low-cost sensors give wide coverage but can drift, freeze or be tampered with. AirTrust:\n- validates every reading with explainable AI (anomaly + confidence scores),\n- confirms pollution events with neighbouring sensors and citizen reports,\n- seals the evidence on a blockchain so nobody can rewrite it later,\n- lets anyone verify any record publicly.\nUsers: residents, schools, NGOs, city agencies, researchers.",
      "O **AirTrust** torna dados de qualidade do ar **confiáveis**. Sensores baratos cobrem muito mais área, mas podem descalibrar, travar ou ser adulterados. O AirTrust:\n- valida cada leitura com IA explicável (notas de anomalia e de confiança),\n- confirma eventos de poluição com sensores vizinhos e relatos de cidadãos,\n- sela a evidência numa blockchain para ninguém reescrever depois,\n- deixa qualquer pessoa verificar qualquer registro.\nPúblico: moradores, escolas, ONGs, prefeituras, pesquisadores.");

  for (const [re, key] of gloss) if (re.test(q) && (isWhat || !sensor)) return GLOSSARY[key][L];

  if (isWhat || /\baba\b|\btab\b/.test(q)) for (const [re, key] of tabMap) if (re.test(q)) return GUIDE[key][L];

  // Safety / health
  if (/segur|safe|correr|run|exerc|caminh|walk|sair|outside|ao ar livre|respirar|breathe|janela|window|crian|child|asma|asthma/.test(q)) {
    if (sensor) {
      if (!sensor.level) return t(`${sensor.code} (${sensor.district}) has no live data right now (${sensor.status}). Check a neighbouring sensor on the map.`, `O ${sensor.code} (${sensor.district}) está sem dados ao vivo agora (${sensor.status}). Veja um sensor vizinho no mapa.`);
      return `${sensorLine(sensor)}\n\n${ADVICE[sensor.level][L]}${sensor.ai_status === "suspicious" || sensor.ai_status === "sensor_fault" ? t(" Note: the AI does not fully trust this sensor right now; check its neighbours.", " Atenção: a IA não confia totalmente nesse sensor agora; confira os vizinhos.") : ""}\n\n${disclaimer}`;
    }
    const worst = live.filter((s) => s.ai_status === "valid" || s.ai_status === "anomalous").sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])[0];
    if (!worst) return t("No live sensor data right now.", "Sem dados de sensores ao vivo agora.");
    return t(`City-wide, the worst trusted reading is ${worst.code} (${worst.district}): air **${lvlName.en[worst.level]}**.`, `Na cidade, a pior leitura confiável agora é ${worst.code} (${worst.district}): ar **${lvlName.pt[worst.level]}**.`) +
      `\n\n${ADVICE[worst.level][L]}\n\n${t("Tell me your neighbourhood (e.g. Pinheiros, Mooca) for a local answer.", "Me diga seu bairro (ex.: Pinheiros, Mooca) para uma resposta local.")}\n\n${disclaimer}`;
  }

  // Forecast
  if (/previs|forecast|amanha|tomorrow|proximas horas|next hours|vai piorar|will it/.test(q))
    return t(`Forecasts (1, 3 and 6 h, with 95% intervals) are in each sensor's detail panel: click ${sensor ? sensor.code : "a sensor"} on the Command Center map.`, `As previsões (1, 3 e 6 h, com intervalo de 95%) ficam no painel de cada sensor: clique em ${sensor ? sensor.code : "um sensor"} no mapa do Command Center.`);

  if (sensor) return `${sensorLine(sensor)}${sensor.explanation ? `\n\n${t("AI explanation", "Explicação da IA")}: ${sensor.explanation}` : ""}${sensor.drift > 1.25 ? t(`\n\nCalibration drift ×${sensor.drift}: recalibration recommended.`, `\n\nDescalibração ×${sensor.drift}: recomendada recalibração.`) : ""}`;

  // Events
  if (/event|episod|queimad|fumaca|smoke|fire|incendio|poeira|dust/.test(q)) {
    if (!snap.events.length) return t("No environmental events recorded yet.", "Nenhum evento ambiental registrado ainda.");
    const act = snap.events.filter((e) => e.active && e.status !== "dismissed");
    const list = (act.length ? act : snap.events.slice(0, 4)).map((e) => `- **${e.title}** (${e.code}) · ${e.status}${e.active ? t(" · ongoing", " · em andamento") : ""} · ${lvlName[L][e.severity] || e.severity} · ${t("confidence", "confiança")} ${Math.round(e.confidence_score)}% · ${t("sensors", "sensores")} ${e.sensor_codes.join(", ")}${e.block_number ? ` · ${t("on-chain block", "bloco")} #${e.block_number}` : ""}`).join("\n");
    return (act.length ? t("Ongoing events:\n", "Eventos em andamento:\n") : t("No ongoing event. Most recent:\n", "Nenhum evento em andamento. Mais recentes:\n")) + list + t("\n\nDetails and timeline in the **Events** tab.", "\n\nDetalhes e linha do tempo na aba **Events**.");
  }

  // Alerts
  if (/alert|aviso|perigo|danger/.test(q))
    return snap.alerts.length ? t("Active alerts:\n", "Alertas ativos:\n") + snap.alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n") : t("No active alerts right now.", "Nenhum alerta ativo agora.");

  // Faulty sensors
  if (/defeit|fault|problem|offline|quebrad|broken|manuten|maintenance/.test(q)) {
    const bad = snap.sensors.filter((s) => s.status !== "online" || ["sensor_fault", "suspicious"].includes(s.ai_status));
    return bad.length ? t("Sensors needing attention:\n", "Sensores que precisam de atenção:\n") + bad.map((s) => `- **${s.code} · ${s.district}**: ${s.status === "offline" ? "offline" : s.drift > 1.25 ? t(`calibration drift ×${s.drift}`, `descalibrado ×${s.drift}`) : statusName[L][s.ai_status] || s.status}`).join("\n") : t("All sensors are healthy.", "Todos os sensores estão saudáveis.");
  }

  // Status overview (default for "now" questions)
  if (/agora|now|status|situac|resumo|summary|como esta|how is|qualidade|quality|ar de sao paulo|overview|acontec|happening/.test(q) || q.length < 25) {
    const online = snap.sensors.filter((s) => s.status !== "offline").length;
    const ranked = live.filter((s) => s.level).sort((a, b) => (b.pm25 || 0) - (a.pm25 || 0));
    const act = snap.events.filter((e) => e.active && e.status !== "dismissed");
    return [
      t(`**São Paulo right now** (${online}/${snap.sensors.length} sensors online, simulated data):`, `**São Paulo agora** (${online}/${snap.sensors.length} sensores online, dados simulados):`),
      ranked[0] ? t(`- Highest PM2.5: ${ranked[0].code} · ${ranked[0].district} ${f(ranked[0].pm25)} µg/m³ (overall air: ${lvlName.en[ranked[0].level]})`, `- Maior PM2.5: ${ranked[0].code} · ${ranked[0].district} ${f(ranked[0].pm25)} µg/m³ (ar no geral: ${lvlName.pt[ranked[0].level]})`) : "",
      ranked.at(-1) ? t(`- Cleanest: ${ranked.at(-1).code} · ${ranked.at(-1).district} ${f(ranked.at(-1).pm25)} µg/m³`, `- Mais limpo: ${ranked.at(-1).code} · ${ranked.at(-1).district} ${f(ranked.at(-1).pm25)} µg/m³`) : "",
      act.length ? t(`- Ongoing event: **${act[0].title}** (${act[0].status}, ${Math.round(act[0].confidence_score)}%)`, `- Evento em andamento: **${act[0].title}** (${act[0].status}, ${Math.round(act[0].confidence_score)}%)`) : t("- No ongoing pollution event", "- Nenhum evento de poluição em andamento"),
      t(`- Active alerts: ${snap.alerts.length}`, `- Alertas ativos: ${snap.alerts.length}`),
      t(`- Blockchain: ${snap.anchored.toLocaleString()} of ${snap.total.toLocaleString()} readings sealed`, `- Blockchain: ${snap.anchored.toLocaleString()} de ${snap.total.toLocaleString()} leituras seladas`),
    ].filter(Boolean).join("\n");
  }

  return t(
    "I can answer from AirTrust's live data. Try:\n- \"What's happening right now?\"\n- \"Is it safe to run in Pinheiros?\"\n- \"Why is AT-010 flagged?\"\n- \"What does each tab do?\"\n- \"How does the blockchain verification work?\"\n- \"What is PM2.5?\"",
    "Eu respondo com os dados ao vivo do AirTrust. Tente:\n- \"O que está acontecendo agora?\"\n- \"É seguro correr em Pinheiros?\"\n- \"Por que o AT-010 está marcado?\"\n- \"O que faz cada aba?\"\n- \"Como funciona a verificação na blockchain?\"\n- \"O que é PM2.5?\"");
}

function status() {
  const a = config.assistant;
  return a.apiKey ? { mode: "llm", provider: a.baseUrl.includes("groq") ? "Groq" : a.format === "anthropic" ? "Anthropic" : "OpenAI-compatible", model: a.model } : { mode: "offline", provider: "AirTrust offline assistant", model: "rule-based, live data" };
}

async function answer({ messages, core, db, ledgerStatus }) {
  const snap = snapshot(core, db, ledgerStatus);
  const question = String(messages.filter((m) => m.role !== "assistant").at(-1)?.content || "").slice(0, 2000);
  if (config.assistant.apiKey) {
    try {
      const text = await askLLM(messages, contextText(snap));
      if (text) return { answer: text, ...status() };
    } catch (e) {
      return { answer: localAnswer(question, snap), mode: "offline", provider: "AirTrust offline assistant", model: "rule-based, live data", fallback_reason: `LLM unavailable: ${e.name === "AbortError" ? "timeout" : e.message}` };
    }
  }
  return { answer: localAnswer(question, snap), ...status() };
}

module.exports = { answer, status, localAnswer, snapshot, contextText, GUIDE, GLOSSARY };
