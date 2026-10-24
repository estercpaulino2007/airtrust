// Sorted-pair SHA-256 Merkle tree. Must match AirTrustLedger.verifyBatchMembership.
// All hashes are lowercase hex strings WITHOUT the 0x prefix.
const crypto = require("crypto");

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashPair = (a, b) => {
  const [x, y] = a <= b ? [a, b] : [b, a];
  return crypto.createHash("sha256").update(Buffer.from(x + y, "hex")).digest("hex");
};

/** Builds all levels. An odd node at the end of a level is promoted unchanged. */
function buildMerkle(leaves) {
  if (!leaves.length) throw new Error("empty batch");
  const levels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return { levels, root: levels[levels.length - 1][0] };
}

function getProof(tree, index) {
  const proof = [];
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const level = tree.levels[l];
    const sib = index % 2 ? index - 1 : index + 1;
    if (sib < level.length) proof.push(level[sib]);
    index = Math.floor(index / 2);
  }
  return proof;
}

function verifyProof(leaf, proof, root) {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h === root;
}

module.exports = { sha256Hex, hashPair, buildMerkle, getProof, verifyProof };
