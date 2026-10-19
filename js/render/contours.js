// Marching-squares isolines over a regular grid, chained into polylines.
// grid: Float32Array row-major (index = j * nx + i). Output points are in grid
// coordinates (i, j as floats).

// For each case, pairs of edges that a segment connects.
// Edges: 0 = bottom (j, i→i+1), 1 = right (i+1, j→j+1), 2 = top (j+1), 3 = left (i).
const CASES = [
  [], [[3, 0]], [[0, 1]], [[3, 1]],
  [[1, 2]], null, [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], null, [[1, 2]],
  [[1, 3]], [[0, 1]], [[3, 0]], [],
];

export function isolines(grid, nx, ny, level) {
  const nodes = new Map(); // edge key -> { p: [x, y], links: [] }
  const segs = [];

  const edgeKey = (i, j, e) => {
    // Normalise so shared edges get the same key.
    if (e === 0) return `h${i},${j}`;
    if (e === 2) return `h${i},${j + 1}`;
    if (e === 3) return `v${i},${j}`;
    return `v${i + 1},${j}`;
  };

  const edgePoint = (i, j, e, v00, v10, v11, v01) => {
    let a, b, pa, pb;
    if (e === 0) { a = v00; b = v10; pa = [i, j]; pb = [i + 1, j]; }
    else if (e === 1) { a = v10; b = v11; pa = [i + 1, j]; pb = [i + 1, j + 1]; }
    else if (e === 2) { a = v01; b = v11; pa = [i, j + 1]; pb = [i + 1, j + 1]; }
    else { a = v00; b = v01; pa = [i, j]; pb = [i, j + 1]; }
    const t = a === b ? 0.5 : (level - a) / (b - a);
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };

  const node = (key, p) => {
    let n = nodes.get(key);
    if (!n) {
      n = { p, links: [] };
      nodes.set(key, n);
    }
    return n;
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v00 = grid[j * nx + i];
      const v10 = grid[j * nx + i + 1];
      const v11 = grid[(j + 1) * nx + i + 1];
      const v01 = grid[(j + 1) * nx + i];
      const c = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      let pairs = CASES[c];
      if (pairs === null) {
        // Saddle: decide using the centre value.
        const centre = (v00 + v10 + v11 + v01) / 4 >= level;
        if (c === 5) pairs = centre ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        else pairs = centre ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      }
      for (const [e1, e2] of pairs) {
        const k1 = edgeKey(i, j, e1);
        const k2 = edgeKey(i, j, e2);
        const n1 = node(k1, edgePoint(i, j, e1, v00, v10, v11, v01));
        const n2 = node(k2, edgePoint(i, j, e2, v00, v10, v11, v01));
        const s = { a: k1, b: k2, used: false };
        segs.push(s);
        n1.links.push(s);
        n2.links.push(s);
      }
    }
  }

  const lines = [];
  const walk = (startKey, seg) => {
    const pts = [nodes.get(startKey).p];
    let key = startKey;
    let s = seg;
    while (s && !s.used) {
      s.used = true;
      key = s.a === key ? s.b : s.a;
      pts.push(nodes.get(key).p);
      s = nodes.get(key).links.find((l) => !l.used);
    }
    return pts;
  };

  // Open chains first (start at nodes with a single link), then loops.
  for (const [key, n] of nodes) {
    if (n.links.length === 1 && !n.links[0].used) lines.push(walk(key, n.links[0]));
  }
  for (const s of segs) {
    if (!s.used) lines.push(walk(s.a, s));
  }
  return lines;
}

/** Pick a "nice" contour interval giving roughly `target` lines over a range. */
export function niceInterval(range, target = 15, unit = 1) {
  const raw = range / unit / target;
  const steps = [1, 2, 2.5, 5, 10];
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const s of steps) {
    if (s * mag >= raw) return s * mag * unit;
  }
  return 10 * mag * unit;
}
