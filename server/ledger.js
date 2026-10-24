// Trust Ledger service: talks to AirTrustLedger.sol through ethers.js.
// Default = local Hardhat node. Set RPC_URL + LEDGER_PRIVATE_KEY + CONTRACT_ADDRESS for Polygon Amoy.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("./config");

const ARTIFACT = path.join(__dirname, "..", "artifacts", "contracts", "AirTrustLedger.sol", "AirTrustLedger.json");
const x = (h) => (h.startsWith("0x") ? h : "0x" + h);

class Ledger {
  constructor({ db, log = () => {} }) {
    this.db = db; this.log = log; this.queue = Promise.resolve(); this.ready = false;
    this.network = null; this.address = null; this.error = null;
  }

  async connect() {
    try {
      const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { pollingInterval: 1000 });
      const net = await this.provider.getNetwork();
      this.signer = config.privateKey ? new ethers.Wallet(config.privateKey, this.provider) : await this.provider.getSigner(0);
      const metaKey = `contract_${net.chainId}`;
      let address = config.contractAddress || this.db.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey)?.value;
      if (address && (await this.provider.getCode(address)) === "0x") address = null; // node was restarted
      if (!address) {
        const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, this.signer);
        const c = await factory.deploy();
        await c.waitForDeployment();
        address = await c.getAddress();
        this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(metaKey, address);
        this.log(`AirTrustLedger deployed at ${address}`);
      }
      this.contract = new ethers.Contract(address, artifact.abi, this.signer);
      this.address = address;
      this.network = { chainId: Number(net.chainId), name: net.chainId === 31337n ? "hardhat-local" : net.name };
      this.ready = true; this.error = null;
      return true;
    } catch (e) {
      this.ready = false; this.error = e.shortMessage || e.message;
      return false;
    }
  }

  /** Serialises transactions so nonces never collide. */
  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async send(method, ...args) {
    if (!this.ready) throw new Error("ledger offline");
    return this.enqueue(async () => {
      const tx = await this.contract[method](...args);
      const rc = await tx.wait();
      return { txHash: rc.hash, blockNumber: rc.blockNumber, contractAddress: this.address };
    });
  }

  anchorBatch(root, count, fromMs, toMs) {
    return this.send("submitBatchProof", x(root), count, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
  }
  anchorReading(hash, sensor, pollutant, value, status) {
    return this.send("submitReadingProof", x(hash), sensor, pollutant, Math.round(value * 100), status);
  }
  anchorEvent(hash, type, severity) { return this.send("submitEventProof", x(hash), type, severity); }

  async verifyBatchMembership(root, leaf, proof) {
    return this.contract.verifyBatchMembership(x(root), x(leaf), proof.map(x));
  }
  async verifyReading(hash) { return this.contract.verifyReadingProof(x(hash)); }
  async verifyEvent(hash) { return this.contract.verifyEventProof(x(hash)); }
  async getBatch(root) {
    try { const b = await this.contract.getBatchProof(x(root)); return { timestamp: Number(b.timestamp), readingCount: Number(b.readingCount), submittedBy: b.submittedBy }; }
    catch { return null; }
  }
  async totals() {
    const [r, e, b] = await this.contract.getTotalProofs();
    return { readings: Number(r), events: Number(e), batches: Number(b) };
  }
  async status() {
    if (!this.ready) return { connected: false, error: this.error, rpc: config.rpcUrl };
    try {
      const block = await this.provider.getBlockNumber();
      return { connected: true, network: this.network, contract: this.address, block, totals: await this.totals(), explorerTxUrl: config.explorerTxUrl || null };
    } catch (e) { return { connected: false, error: e.message }; }
  }
}

module.exports = { Ledger };
