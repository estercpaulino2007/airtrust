const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const { buildMerkle, getProof, sha256Hex } = require("../server/lib/merkle");

const h = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex");

describe("AirTrustLedger", () => {
  let ledger, owner, stranger;

  beforeEach(async () => {
    [owner, stranger] = await ethers.getSigners();
    ledger = await (await ethers.getContractFactory("AirTrustLedger")).deploy();
  });

  describe("reading proofs", () => {
    it("stores a proof, emits an event and verifies it", async () => {
      const hash = h("AT-007|pm25|92.47");
      await expect(ledger.submitReadingProof(hash, "AT-007", "pm25", 9247, "anomalous"))
        .to.emit(ledger, "ReadingProofSubmitted");
      expect(await ledger.verifyReadingProof(hash)).to.equal(true);
      const p = await ledger.getReadingProof(hash);
      expect(p.sensorId).to.equal("AT-007");
      expect(p.value).to.equal(9247n);
    });

    it("rejects duplicate hashes", async () => {
      const hash = h("dup");
      await ledger.submitReadingProof(hash, "AT-001", "pm25", 100, "valid");
      await expect(ledger.submitReadingProof(hash, "AT-001", "pm25", 100, "valid"))
        .to.be.revertedWithCustomError(ledger, "DuplicateHash");
    });

    it("rejects the zero hash", async () => {
      await expect(ledger.submitReadingProof(ethers.ZeroHash, "AT-001", "pm25", 1, "valid"))
        .to.be.revertedWithCustomError(ledger, "EmptyHash");
    });

    it("returns false for an unknown (tampered) hash", async () => {
      await ledger.submitReadingProof(h("original"), "AT-001", "pm25", 1, "valid");
      expect(await ledger.verifyReadingProof(h("tampered"))).to.equal(false);
    });

    it("blocks unauthorised submitters until the owner allows them", async () => {
      const hash = h("x");
      await expect(ledger.connect(stranger).submitReadingProof(hash, "A", "pm25", 1, "valid"))
        .to.be.revertedWithCustomError(ledger, "NotAuthorized");
      await ledger.setSubmitter(stranger.address, true);
      await expect(ledger.connect(stranger).submitReadingProof(hash, "A", "pm25", 1, "valid")).to.not.be.reverted;
    });
  });

  describe("event proofs", () => {
    it("stores and retrieves event proofs, rejecting duplicates", async () => {
      const hash = h("event-1");
      await expect(ledger.submitEventProof(hash, "wildfire_smoke", "critical")).to.emit(ledger, "EventProofSubmitted");
      expect((await ledger.getEventProof(hash)).eventType).to.equal("wildfire_smoke");
      await expect(ledger.submitEventProof(hash, "wildfire_smoke", "critical"))
        .to.be.revertedWithCustomError(ledger, "DuplicateHash");
    });

    it("reverts when reading a missing proof", async () => {
      await expect(ledger.getEventProof(h("missing"))).to.be.revertedWithCustomError(ledger, "ProofNotFound");
    });
  });

  describe("Merkle batch proofs", () => {
    it("verifies membership on-chain with the same algorithm used off-chain", async () => {
      const leaves = Array.from({ length: 37 }, (_, i) => sha256Hex(`reading-${i}`));
      const tree = buildMerkle(leaves);
      await ledger.submitBatchProof("0x" + tree.root, leaves.length, 1, 2);

      for (const idx of [0, 5, 36]) {
        const proof = getProof(tree, idx).map((x) => "0x" + x);
        expect(await ledger.verifyBatchMembership("0x" + tree.root, "0x" + leaves[idx], proof)).to.equal(true);
      }
      const proof0 = getProof(tree, 0).map((x) => "0x" + x);
      expect(await ledger.verifyBatchMembership("0x" + tree.root, "0x" + sha256Hex("tampered"), proof0)).to.equal(false);
    });

    it("counts totals across proof types", async () => {
      await ledger.submitReadingProof(h("r"), "A", "pm25", 1, "valid");
      await ledger.submitEventProof(h("e"), "dust_event", "poor");
      await ledger.submitBatchProof(h("b"), 10, 1, 2);
      const [r, e, b] = await ledger.getTotalProofs();
      expect([r, e, b]).to.deep.equal([1n, 1n, 1n]);
    });
  });
});
