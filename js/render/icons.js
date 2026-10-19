// Small filled icons for engraving. Every function returns SVG path data
// centred on (cx, cy) and roughly `s` mm tall. Fill with the nonzero rule:
// solids wind clockwise and holes counter-clockwise, like font outlines.

import { fmt, circlePath, ribbon, signedArea } from './geometry.js';

const poly = (pts, hole = false) => {
  const cw = signedArea(pts) > 0;
  const ordered = cw === !hole ? pts : pts.slice().reverse();
  return `M${ordered.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`;
};

function place(cx, cy, s, pts) {
  // pts given in a unit box [-0.5, 0.5].
  return pts.map(([x, y]) => [cx + x * s, cy + y * s]);
}

export function circle(cx, cy, s) {
  return circlePath(cx, cy, s * 0.42);
}

export function square(cx, cy, s) {
  const h = s * 0.38;
  return poly([[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]);
}

export function diamond(cx, cy, s) {
  const h = s * 0.5;
  const w = s * 0.36;
  return poly([[cx, cy - h], [cx + w, cy], [cx, cy + h], [cx - w, cy]]);
}

export function doubleDiamond(cx, cy, s) {
  const w = s * 0.36;
  return diamond(cx - w * 1.08, cy, s) + diamond(cx + w * 1.08, cy, s);
}

/** Difficulty symbol width (for layout). */
export function difficultyIconWidth(level, s) {
  return level === 'double' ? s * 1.5 : s * 0.85;
}

export function difficultyIcon(level, cx, cy, s) {
  switch (level) {
    case 'circle': return circle(cx, cy, s);
    case 'square': return square(cx, cy, s);
    case 'diamond': return diamond(cx, cy, s);
    case 'double': return doubleDiamond(cx, cy, s);
    default: return circle(cx, cy, s);
  }
}

/** Twin peaks with a snow cap cut out of the larger one. */
export function peak(cx, cy, s) {
  const back = place(cx, cy, s, [[-0.05, 0.36], [0.22, -0.12], [0.55, 0.36]]);
  const front = place(cx, cy, s, [[-0.55, 0.36], [-0.12, -0.42], [0.3, 0.36]]);
  const snow = place(cx, cy, s, [
    [-0.12, -0.3], [-0.005, -0.12], [-0.06, -0.16], [-0.12, -0.09], [-0.17, -0.16], [-0.235, -0.12],
  ]);
  return poly(back) + poly(front) + poly(snow, true);
}

/** Up/down arrow with end bars: vertical drop. */
export function vertical(cx, cy, s) {
  const t = 0.07;
  const shaft = place(cx, cy, s, [[-t, -0.24], [t, -0.24], [t, 0.24], [-t, 0.24]]);
  const up = place(cx, cy, s, [[0, -0.5], [0.24, -0.22], [-0.24, -0.22]]);
  const down = place(cx, cy, s, [[0, 0.5], [-0.24, 0.22], [0.24, 0.22]]);
  return poly(shaft) + poly(up) + poly(down);
}

/** Two carving ski tracks. */
export function tracks(cx, cy, s) {
  let d = '';
  for (const off of [-0.16, 0.16]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push([cx + (off + 0.2 * Math.sin(t * Math.PI * 2.2)) * s, cy + (t - 0.5) * s]);
    }
    d += poly(ribbon(pts, s * 0.055).slice(0, -1));
  }
  return d;
}

/** Crosshair / location ring. */
export function crosshair(cx, cy, s) {
  const r = s * 0.32;
  const t = s * 0.06;
  let d = circlePath(cx, cy, r + t) + circlePath(cx, cy, r - t, true);
  const arm = s * 0.18;
  d += poly([[cx - t, cy - r - t - arm], [cx + t, cy - r - t - arm], [cx + t, cy - r + t], [cx - t, cy - r + t]]);
  d += poly([[cx - t, cy + r - t], [cx + t, cy + r - t], [cx + t, cy + r + t + arm], [cx - t, cy + r + t + arm]]);
  d += poly([[cx - r - t - arm, cy - t], [cx - r + t, cy - t], [cx - r + t, cy + t], [cx - r - t - arm, cy + t]]);
  d += poly([[cx + r - t, cy - t], [cx + r + t + arm, cy - t], [cx + r + t + arm, cy + t], [cx + r - t, cy + t]]);
  d += circlePath(cx, cy, s * 0.08);
  return d;
}

/** Chairlift: cable, hanger and seat. */
export function chairlift(cx, cy, s) {
  const cable = place(cx, cy, s, [[-0.5, -0.38], [0.5, -0.24], [0.5, -0.18], [-0.5, -0.32]]);
  const hanger = place(cx, cy, s, [[-0.03, -0.31], [0.04, -0.3], [0.04, 0.18], [-0.03, 0.18]]);
  const seat = place(cx, cy, s, [[-0.3, 0.12], [0.22, 0.12], [0.22, 0.2], [-0.22, 0.2], [-0.22, 0.4], [-0.3, 0.4]]);
  return poly(cable) + poly(hanger) + poly(seat);
}

export function star(cx, cy, s, points = 5) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? s * 0.5 : s * 0.21;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}

export function heart(cx, cy, s) {
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (x / 34) * s, cy - (y / 34) * s - s * 0.04]);
  }
  return poly(pts);
}

/** Small compass rose: north arrow. */
export function northArrow(cx, cy, s) {
  const left = place(cx, cy, s, [[0, -0.5], [-0.22, 0.32], [0, 0.18]]);
  const right = place(cx, cy, s, [[0, -0.5], [0, 0.18], [0.22, 0.32], [0.06, 0.2]]);
  return poly(left) + poly(right);
}

export function dot(cx, cy, r) {
  return circlePath(cx, cy, r);
}

/** A-frame lodge: base area. */
export function lodge(cx, cy, s) {
  const roof = place(cx, cy, s, [[0, -0.48], [0.5, 0.3], [0.36, 0.3], [0, -0.26], [-0.36, 0.3], [-0.5, 0.3]]);
  const body = place(cx, cy, s, [[0, -0.16], [0.28, 0.3], [0.28, 0.42], [0.08, 0.42], [0.08, 0.18], [-0.08, 0.18], [-0.08, 0.42], [-0.28, 0.42], [-0.28, 0.3]]);
  return poly(roof) + poly(body);
}
