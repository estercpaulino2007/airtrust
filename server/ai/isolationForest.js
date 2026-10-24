// Minimal Isolation Forest (Liu, Ting & Zhou, 2008) for multivariate anomaly scoring.
// score ~ 0.5 normal, -> 1.0 highly anomalous.
const EULER = 0.5772156649;
const c = (n) => (n <= 1 ? 0 : 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n);

class IsolationForest {
  constructor({ trees = 100, sampleSize = 256, rand = Math.random } = {}) {
    this.nTrees = trees; this.sampleSize = sampleSize; this.rand = rand; this.trees = [];
  }

  fit(data) {
    const n = Math.min(this.sampleSize, data.length);
    this.n = n;
    const maxDepth = Math.ceil(Math.log2(n));
    this.trees = [];
    for (let t = 0; t < this.nTrees; t++) {
      const sample = [];
      for (let i = 0; i < n; i++) sample.push(data[Math.floor(this.rand() * data.length)]);
      this.trees.push(this.build(sample, 0, maxDepth));
    }
    return this;
  }

  build(rows, depth, maxDepth) {
    if (depth >= maxDepth || rows.length <= 1) return { size: rows.length };
    const dim = Math.floor(this.rand() * rows[0].length);
    let min = Infinity, max = -Infinity;
    for (const r of rows) { if (r[dim] < min) min = r[dim]; if (r[dim] > max) max = r[dim]; }
    if (min === max) return { size: rows.length };
    const split = min + this.rand() * (max - min);
    const left = [], right = [];
    for (const r of rows) (r[dim] < split ? left : right).push(r);
    return { dim, split, left: this.build(left, depth + 1, maxDepth), right: this.build(right, depth + 1, maxDepth) };
  }

  pathLength(x, node, depth = 0) {
    if (node.size !== undefined) return depth + c(node.size);
    return this.pathLength(x, x[node.dim] < node.split ? node.left : node.right, depth + 1);
  }

  score(x) {
    if (!this.trees.length) return 0.5;
    let sum = 0;
    for (const t of this.trees) sum += this.pathLength(x, t);
    return Math.pow(2, -(sum / this.trees.length) / c(this.n));
  }
}

/** Feature vector used by the forest (log-scaled so ratios matter more than magnitudes). */
const features = (r) => [
  Math.log1p(r.pm25), Math.log1p(r.pm10), Math.log1p(r.no2), Math.log1p(r.o3),
  r.temperature / 10, r.humidity / 25, r.pm25 / Math.max(r.pm10, 1),
];

module.exports = { IsolationForest, features };
