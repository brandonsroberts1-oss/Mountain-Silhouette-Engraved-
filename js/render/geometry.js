// Polyline geometry helpers. A point is [x, y]; a polyline is an array of points.

export function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

/** Insert points so that no segment is longer than maxStep. */
export function densify(pts, maxStep) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / maxStep));
    for (let k = 1; k <= n; k++) out.push(lerp(a, b, k / n));
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification (iterative, keeps endpoints). */
export function simplify(pts, tolerance) {
  if (pts.length < 3 || tolerance <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting; endpoints are preserved. */
export function chaikin(pts, iterations = 1) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur.slice();
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      out.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

export function bounds(lines) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Clipping. Shapes are described as { type: 'rect', x, y, w, h } or
// { type: 'circle', cx, cy, r }. A clip region is { shape, holes: [shape...] }:
// lines are kept inside `shape` and outside every hole.

function rectIntervals(p, q, r) {
  // Liang–Barsky: returns [[t0, t1]] or [].
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [-dx, p[0] - r.x],
    [dx, r.x + r.w - p[0]],
    [-dy, p[1] - r.y],
    [dy, r.y + r.h - p[1]],
  ];
  for (const [pp, qq] of checks) {
    if (pp === 0) {
      if (qq < 0) return [];
    } else {
      const t = qq / pp;
      if (pp < 0) {
        if (t > t1) return [];
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return [];
        if (t < t1) t1 = t;
      }
    }
  }
  return t1 > t0 ? [[t0, t1]] : [];
}

function circleIntervals(p, q, c) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const fx = p[0] - c.cx;
  const fy = p[1] - c.cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - c.r * c.r;
  if (a === 0) return cc <= 0 ? [[0, 1]] : [];
  const disc = b * b - 4 * a * cc;
  if (disc <= 0) return [];
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - sq) / (2 * a));
  const t1 = Math.min(1, (-b + sq) / (2 * a));
  return t1 > t0 ? [[t0, t1]] : [];
}

function shapeIntervals(p, q, shape) {
  return shape.type === 'circle' ? circleIntervals(p, q, shape) : rectIntervals(p, q, shape);
}

function subtractIntervals(intervals, cut) {
  const out = [];
  for (const [a, b] of intervals) {
    let pieces = [[a, b]];
    for (const [c, d] of cut) {
      const next = [];
      for (const [x, y] of pieces) {
        if (d <= x || c >= y) {
          next.push([x, y]);
        } else {
          if (c > x) next.push([x, c]);
          if (d < y) next.push([d, y]);
        }
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

/** Clip one polyline to a region; returns zero or more polylines. */
export function clipPolyline(pts, region) {
  const out = [];
  let cur = null;
  const EPS = 1e-9;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    let iv = region.shape ? shapeIntervals(p, q, region.shape) : [[0, 1]];
    for (const hole of region.holes || []) {
      if (!iv.length) break;
      iv = subtractIntervals(iv, shapeIntervals(p, q, hole));
    }
    let endedAtOne = false;
    for (const [t0, t1] of iv) {
      if (t1 - t0 < EPS) continue;
      const a = t0 <= EPS ? p : lerp(p, q, t0);
      const b = t1 >= 1 - EPS ? q : lerp(p, q, t1);
      if (cur && t0 <= EPS) {
        cur.push(b);
      } else {
        if (cur) out.push(cur);
        cur = [a, b];
      }
      endedAtOne = t1 >= 1 - EPS;
      if (!endedAtOne) {
        out.push(cur);
        cur = null;
      }
    }
    if (!endedAtOne && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length >= 2);
}

export function clipPolylines(lines, region) {
  const out = [];
  for (const l of lines) out.push(...clipPolyline(l, region));
  return out;
}

export function pointInShape([x, y], shape) {
  if (shape.type === 'circle') return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
  return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
}

// ---------------------------------------------------------------------------

/** Split a polyline into real dash segments (laser software often ignores dasharray). */
export function dashPolyline(pts, dash, gap) {
  const out = [];
  if (pts.length < 2 || dash <= 0) return [pts];
  let on = true;
  let remaining = dash;
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let segLen = dist(a, b);
    while (segLen > 0) {
      if (segLen >= remaining) {
        const p = lerp(a, b, remaining / segLen);
        if (on) {
          cur.push(p);
          out.push(cur);
        }
        on = !on;
        cur = [p];
        segLen -= remaining;
        a = p;
        remaining = on ? dash : gap;
      } else {
        if (on) cur.push(b);
        remaining -= segLen;
        segLen = 0;
      }
    }
  }
  if (on && cur.length > 1) out.push(cur);
  return out;
}

/** Closed outline around a polyline at half-width w (a "ribbon"). */
export function ribbon(pts, w) {
  if (pts.length < 2) return [];
  const n = pts.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }
  const left = pts.map((p, i) => [p[0] + normals[i][0] * w, p[1] + normals[i][1] * w]);
  const right = pts.map((p, i) => [p[0] - normals[i][0] * w, p[1] - normals[i][1] * w]);
  return [...left, ...right.reverse(), left[0]];
}

export function fmt(n, precision = 3) {
  const v = Number(n.toFixed(precision));
  return Object.is(v, -0) ? '0' : String(v);
}

/** SVG path data for polylines. */
export function pathData(lines, precision = 3, close = false) {
  let d = '';
  for (const l of lines) {
    if (l.length < 2) continue;
    d += `M${fmt(l[0][0], precision)} ${fmt(l[0][1], precision)}`;
    for (let i = 1; i < l.length; i++) d += `L${fmt(l[i][0], precision)} ${fmt(l[i][1], precision)}`;
    if (close) d += 'Z';
  }
  return d;
}

/** Full circle; `reverse` flips the winding so it punches a hole under nonzero fill. */
export function circlePath(cx, cy, r, reverse = false) {
  const f = (v) => fmt(v);
  const sw = reverse ? 1 : 0;
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sw} ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sw} ${f(cx - r)} ${f(cy)}Z`;
}

/** Signed area (positive = clockwise on screen, y down). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function rectPath(x, y, w, h, r = 0) {
  const f = (v) => fmt(v);
  if (r <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  r = Math.min(r, w / 2, h / 2);
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

/** Resample at uniform arc-length spacing (both endpoints kept). */
export function resample(pts, spacing) {
  if (pts.length < 2) return pts.slice();
  const total = polylineLength(pts);
  const n = Math.max(1, Math.round(total / spacing));
  const step = total / n;
  const out = [pts[0]];
  let seg = 0;
  let segStart = 0;
  let segLen = dist(pts[0], pts[1]);
  for (let k = 1; k < n; k++) {
    const target = k * step;
    while (segStart + segLen < target && seg < pts.length - 2) {
      segStart += segLen;
      seg++;
      segLen = dist(pts[seg], pts[seg + 1]);
    }
    const t = segLen > 0 ? Math.min(1, (target - segStart) / segLen) : 0;
    out.push(lerp(pts[seg], pts[seg + 1], t));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Gaussian smoothing of a uniformly sampled polyline. `sigma` is in samples.
 * The window shrinks symmetrically near the ends, so endpoints stay put.
 */
export function gaussianSmooth(pts, sigma) {
  const n = pts.length;
  if (sigma <= 0 || n < 3) return pts.slice();
  const R = Math.ceil(sigma * 2.5);
  const w = Array.from({ length: R + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(R, i, n - 1 - i);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = -r; k <= r; k++) {
      const wk = w[k < 0 ? -k : k];
      sx += pts[i + k][0] * wk;
      sy += pts[i + k][1] * wk;
      sw += wk;
    }
    out[i] = [sx / sw, sy / sw];
  }
  return out;
}

/** Smooth SVG path data: Catmull–Rom through the points, as cubic Béziers. */
export function smoothPathData(lines, precision = 3) {
  const f = (v) => fmt(v, precision);
  let d = '';
  for (const l of lines) {
    if (l.length < 2) continue;
    d += `M${f(l[0][0])} ${f(l[0][1])}`;
    if (l.length === 2) {
      d += `L${f(l[1][0])} ${f(l[1][1])}`;
      continue;
    }
    for (let i = 0; i < l.length - 1; i++) {
      const p0 = l[i - 1] || l[i];
      const p1 = l[i];
      const p2 = l[i + 1];
      const p3 = l[i + 2] || l[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
    }
  }
  return d;
}

/**
 * Closed outline of a stroke with per-point half-widths and round caps, so a
 * line can be engraved as a solid filled shape.
 */
export function strokeOutline(pts, halfWidths) {
  const n = pts.length;
  if (n < 2) return [];
  const dirs = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = dirs[Math.max(0, i - 1)];
    const b = dirs[Math.min(n - 2, i)];
    let tx = a[0] + b[0];
    let ty = a[1] + b[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-9) {
      tx = b[0];
      ty = b[1];
    } else {
      tx /= tl;
      ty /= tl;
    }
    // Miter scale, limited so sharp turns don't spike.
    const cos = tx * b[0] + ty * b[1];
    const k = Math.min(2, 1 / Math.max(0.5, cos));
    const hw = halfWidths[i] * k;
    left.push([pts[i][0] - ty * hw, pts[i][1] + tx * hw]);
    right.push([pts[i][0] + ty * hw, pts[i][1] - tx * hw]);
  }
  const cap = (p, t, r, sign) => {
    const out = [];
    const steps = 8;
    for (let s = 1; s < steps; s++) {
      const a = (Math.PI * s) / steps;
      // Normal (left) is [-t.y, t.x]; sweep from left, through the tip, to right.
      const nx = -t[1] * sign;
      const ny = t[0] * sign;
      out.push([p[0] + r * (nx * Math.cos(a) + t[0] * sign * Math.sin(a)), p[1] + r * (ny * Math.cos(a) + t[1] * sign * Math.sin(a))]);
    }
    return out;
  };
  const end = cap(pts[n - 1], dirs[n - 2], halfWidths[n - 1], 1);
  const start = cap(pts[0], dirs[0], halfWidths[0], -1);
  return [...left, ...end, ...right.reverse(), ...start];
}

/**
 * Raster mask of the area within `radius` of the given lines, for knocking
 * other lines out around them. Coordinates in mm; `cell` is the resolution.
 */
export function lineMask(lines, radius, W, H, cell = 0.1) {
  const nx = Math.ceil(W / cell) + 1;
  const ny = Math.ceil(H / cell) + 1;
  const grid = new Uint8Array(nx * ny);
  const r = Math.max(1, Math.round(radius / cell));
  const offsets = [];
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (di * di + dj * dj <= r * r) offsets.push(di, dj);
  for (const l of lines) {
    for (const [x, y] of densify(l, cell)) {
      const ci = Math.round(x / cell);
      const cj = Math.round(y / cell);
      for (let k = 0; k < offsets.length; k += 2) {
        const i = ci + offsets[k];
        const j = cj + offsets[k + 1];
        if (i >= 0 && j >= 0 && i < nx && j < ny) grid[j * nx + i] = 1;
      }
    }
  }
  return (x, y) => {
    const i = Math.round(x / cell);
    const j = Math.round(y / cell);
    return i >= 0 && j >= 0 && i < nx && j < ny && grid[j * nx + i] === 1;
  };
}

/** Split lines wherever they enter the mask. */
export function knockout(lines, masked, cell = 0.1) {
  const out = [];
  for (const l of lines) {
    let cur = null;
    for (const p of densify(l, cell)) {
      if (masked(p[0], p[1])) {
        cur = null;
      } else {
        if (!cur) out.push((cur = []));
        cur.push(p);
      }
    }
  }
  return out.filter((l) => l.length >= 2);
}
