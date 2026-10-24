// One command to run everything locally:
//   1. compile the contract (offline solc-js)
//   2. start a Hardhat node on :8545 (unless RPC_URL points elsewhere or one is already running)
//   3. seed 30 days of data on first run (or with --reseed)
//   4. start the API + WebSocket + command center on :4000
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// Load .env (simple KEY=value parser) before reading config.
try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*([^#]*)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}
const config = require("../server/config");

const root = path.join(__dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const local = !process.env.RPC_URL || /127\.0\.0\.1|localhost/.test(process.env.RPC_URL);

async function rpcUp() {
  try {
    const r = await fetch(config.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch { return false; }
}

(async () => {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`AirTrust needs Node.js 22.13 or newer (built-in SQLite). You have ${process.versions.node}.`);
    process.exit(1);
  }
  console.log("▸ Compiling AirTrustLedger.sol…");
  const c = spawnSync(npx, ["hardhat", "compile", "--quiet"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (c.status !== 0) process.exit(c.status);

  let node;
  let fresh = false;
  if (local && !(await rpcUp())) {
    console.log("▸ Starting local Hardhat blockchain on :8545…");
    node = spawn(npx, ["hardhat", "node"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
    for (let i = 0; i < 60 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 500));
    fresh = true;
  }

  // A fresh chain has no proofs, so history must be re-seeded to keep the ledger consistent.
  if (process.argv.includes("--reseed") || !fs.existsSync(config.dbFile) || (fresh && local)) {
    console.log("▸ Seeding 30 days of simulated history (≈10 s)…");
    const { seed } = require("./seed");
    await seed({ log: (m) => console.log("  " + m) });
  }

  console.log("▸ Starting AirTrust server…");
  const srv = spawn(process.execPath, ["--no-warnings", path.join(root, "server", "index.js")], { cwd: root, stdio: "inherit", env: process.env });
  const stop = () => { srv.kill(); node?.kill(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  srv.on("exit", (code) => { node?.kill(); process.exit(code ?? 0); });
})();
