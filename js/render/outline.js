// Turns lines into engravable filled outlines ("outline stroke"), and merges
// overlapping shapes, using Clipper. Laser software fills each shape on an
// engrave layer; a hairline (score) is a single thin pass, so every line in a
// design is exported as a filled band of real width instead.
//
// Output polygons are unioned and consistently oriented, so they render the
// same under nonzero and even-odd fill rules, and overlaps never burn twice.

import ClipperLib from '../../vendor/clipper.module.js';

const SCALE = 1000; // Clipper works in integers: 1 unit = 1 µm

// ---------------------------------------------------------------------------
// Path flattening (absolute M L H V C Q A Z, as produced by this app)

function cubicPts(p0, p1, p2, p3, out) {
  const ctrl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(2, Math.min(64, Math.ceil(ctrl / 0.12)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t * t;
    const d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
}

function quadPts(p0, p1, p2, out) {
  const ctrl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const n = Math.max(2, Math.min(48, Math.ceil(ctrl / 0.12)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
}

// SVG arc (endpoint form) → points, per SVG 1.1 implementation notes F.6.5.
function arcPts(p0, rx, ry, phiDeg, largeArc, sweep, p1, out) {
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) {
    out.push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 0.1), Math.ceil(Math.abs(dt) / (Math.PI / 90)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  out[out.length - 1] = p1;
}

/** Flatten path data into subpaths: [{ pts: [[x, y], ...], closed }]. */
export function flattenPath(d) {
  const toks = d.match(/[MLHVCQAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let cur = null;
  let i = 0;
  let cmd = '';
  let pos = [0, 0];
  const num = () => +toks[i++];
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++].toUpperCase();
    if (cmd === 'Z') {
      if (cur) {
        cur.closed = true;
        pos = cur.pts[0];
        cur = null;
      }
      continue;
    }
    if (cmd === 'M') {
      pos = [num(), num()];
      cur = { pts: [pos], closed: false };
      subs.push(cur);
      cmd = 'L'; // implicit lineto after the first pair
      continue;
    }
    if (!cur) {
      cur = { pts: [pos], closed: false };
      subs.push(cur);
    }
    if (cmd === 'L') pos = [num(), num()];
    else if (cmd === 'H') pos = [num(), pos[1]];
    else if (cmd === 'V') pos = [pos[0], num()];
    else if (cmd === 'C') {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const p = [num(), num()];
      cubicPts(pos, c1, c2, p, cur.pts);
      pos = p;
      continue;
    } else if (cmd === 'Q') {
      const c1 = [num(), num()];
      const p = [num(), num()];
      quadPts(pos, c1, p, cur.pts);
      pos = p;
      continue;
    } else if (cmd === 'A') {
      const rx = num();
      const ry = num();
      const rot = num();
      const large = num();
      const sweep = num();
      const p = [num(), num()];
      arcPts(pos, rx, ry, rot, !!large, !!sweep, p, cur.pts);
      pos = p;
      continue;
    } else {
      i++; // unknown token: skip
      continue;
    }
    cur.pts.push(pos);
  }
  return subs.filter((s) => s.pts.length >= 2);
}

// ---------------------------------------------------------------------------

const toClipper = (pts) => {
  const out = [];
  let last = null;
  for (const [x, y] of pts) {
    const p = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
    if (!last || p.X !== last.X || p.Y !== last.Y) out.push(p);
    last = p;
  }
  return out;
};

function pathsToD(paths) {
  let d = '';
  for (const poly of paths) {
    if (poly.length < 3) continue;
    d += `M${poly[0].X / SCALE} ${poly[0].Y / SCALE}`;
    for (let k = 1; k < poly.length; k++) d += `L${poly[k].X / SCALE} ${poly[k].Y / SCALE}`;
    d += 'Z';
  }
  return d;
}

/** Clipper paths of a line drawing outlined at `width` mm, with round ends and joins. */
export function strokePaths(d, width) {
  const co = new ClipperLib.ClipperOffset(2, 0.004 * SCALE);
  for (const sub of flattenPath(d)) {
    const pts = toClipper(sub.pts);
    if (pts.length < 2) continue;
    co.AddPath(pts, ClipperLib.JoinType.jtRound, sub.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
  }
  const out = new ClipperLib.Paths();
  co.Execute(out, (width / 2) * SCALE);
  return out;
}

/** Clipper paths of filled path data (nonzero fill). */
export function fillPaths(d) {
  return flattenPath(d).map((s) => toClipper(s.pts)).filter((p) => p.length >= 3);
}

/** Clipper boolean operation on two path sets (nonzero fill). */
export function clip(op, subject, clipPaths = []) {
  const c = new ClipperLib.Clipper();
  if (subject.length) c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  const type = { union: ClipperLib.ClipType.ctUnion, difference: ClipperLib.ClipType.ctDifference, intersection: ClipperLib.ClipType.ctIntersection }[op];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

export { pathsToD };

/** Total area (mm²) of Clipper paths (holes subtract). */
export function area(paths) {
  return paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);
}

/** Union of polygons (nonzero), as SVG path data. */
export function unionToPathData(paths) {
  if (!paths.length) return '';
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return pathsToD(out);
}

/** A line drawing as an engravable filled outline. */
export function strokeToFill(d, width) {
  return unionToPathData(strokePaths(d, width));
}
