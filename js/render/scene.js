// Turns ski runs + a DEM into 2D line art.
//
// Two views:
//  - "3d":  an orthographic oblique view from the base looking uphill, like a
//           painted resort trail map. Hidden lines are removed by ray-marching
//           each trail point toward the viewer through the terrain, and the
//           terrain itself is drawn as ridgelines/silhouette with a floating
//           horizon.
//  - "map": a top-down plan view rotated so uphill points up, with contours.
//
// Scene coordinates use y-up; layout flips them into SVG space.

import { chaikin, densify, simplify, bounds } from './geometry.js';
import { isolines, niceInterval } from './contours.js';

const RAD = Math.PI / 180;

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function frame(azimuthDeg) {
  const a = azimuthDeg * RAD;
  return { f: [Math.sin(a), Math.cos(a)], r: [Math.cos(a), -Math.sin(a)] };
}

function prepRunPts(run, smooth) {
  return smooth > 0 ? chaikin(run.pts, smooth) : run.pts;
}

/**
 * @param model { runs: [{name, difficulty, pts}], lifts: [{name, pts}], radius, baseElevation }
 * @param dem DemGrid in the same local metres
 * @param view see DEFAULT_VIEW
 */
export function buildScene(model, dem, view) {
  return view.mode === 'map' ? buildMap(model, dem, view) : build3d(model, dem, view);
}

export const DEFAULT_VIEW = {
  mode: '3d',
  azimuth: 0,
  pitch: 24,
  exaggeration: 1.7,
  terrain: 'ridges', // none | outline | ridges | contours
  ridgeCount: 48,
  isolate: true,
  smooth: 1,
  contourInterval: 0, // metres, 0 = auto
  showLifts: true,
};

function build3d(model, dem, view) {
  const { f, r } = frame(view.azimuth);
  const th = Math.max(5, Math.min(85, view.pitch)) * RAD;
  const sinT = Math.sin(th);
  const cosT = Math.cos(th);
  const tanT = Math.tan(th);
  const k = view.exaggeration;
  const zBase = model.baseElevation;
  const step = dem.cell;

  const toU = (x, y) => x * r[0] + y * r[1];
  const toD = (x, y) => x * f[0] + y * f[1];

  // The "stage" is the view-aligned box around the runs plus a margin. With
  // isolate on, terrain eases down to the base elevation across the margin so
  // the mountain stands alone instead of ending in cut-off cliffs.
  let u0 = Infinity, u1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  for (const feat of [...model.runs, ...model.lifts]) {
    for (const [x, y] of feat.pts) {
      const u = toU(x, y);
      const d = toD(x, y);
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (d < d0) d0 = d;
      if (d > d1) d1 = d;
    }
  }
  const margin = Math.max(Math.max(u1 - u0, d1 - d0) * 0.22, 250);
  u0 -= margin; u1 += margin; d0 -= margin; d1 += margin;
  const inStage = (u, d) => u >= u0 && u <= u1 && d >= d0 && d <= d1;
  const fade = view.isolate
    ? (u, d) => smoothstep(0, 1, Math.min(u - u0, u1 - u, d - d0, d1 - d) / margin)
    : () => 1;
  const zAt = (x, y) => {
    const z = dem.sample(x, y);
    return zBase + (z - zBase) * fade(toU(x, y), toD(x, y));
  };
  const project = (x, y, z) => [toU(x, y), toD(x, y) * sinT + k * (z - zBase) * cosT];
  const zTop = Math.max(dem.max, zBase + 1);

  // A point is hidden when terrain between it and the viewer rises above the
  // sight line. The sight line climbs tan(pitch)/k metres per metre travelled.
  const visible = (x, y, z) => {
    const climb = tanT / k;
    // Fine steps near the point, coarser further away where occluders are large.
    for (let s = step; ; s += step * Math.max(1, s / (30 * step))) {
      const px = x - f[0] * s;
      const py = y - f[1] * s;
      if (!inStage(toU(px, py), toD(px, py))) return true;
      const rayZ = z + s * climb;
      if (rayZ > zTop) return true;
      if (zAt(px, py) > rayZ + 0.5) return false;
    }
  };

  const splitVisible = (pts3) => {
    const lines = [];
    let cur = null;
    for (const [x, y, z] of pts3) {
      if (visible(x, y, z)) {
        if (!cur) {
          cur = [];
          lines.push(cur);
        }
        cur.push(project(x, y, z));
      } else {
        cur = null;
      }
    }
    return lines.filter((l) => l.length >= 2);
  };

  const trails = model.runs.map((run) => {
    const pts = densify(prepRunPts(run, view.smooth), step * 0.5);
    const pts3 = pts.map(([x, y]) => [x, y, zAt(x, y) + 2]);
    return { name: run.name, difficulty: run.difficulty, lines: splitVisible(pts3) };
  });

  const lifts = view.showLifts
    ? model.lifts.map((lift) => {
        const tower = 9;
        const v3 = lift.pts.map(([x, y]) => [x, y, zAt(x, y) + tower]);
        const pts3 = [];
        for (let i = 1; i < v3.length; i++) {
          const a = v3[i - 1];
          const b = v3[i];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (step * 0.5)));
          for (let s = i === 1 ? 0 : 1; s <= n; s++) {
            const t = s / n;
            pts3.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
          }
        }
        return { name: lift.name, lines: splitVisible(pts3), stations: [project(...v3[0]), project(...v3[v3.length - 1])] };
      })
    : [];

  let terrain = [];
  if (view.terrain === 'ridges' || view.terrain === 'outline') {
    // Floating horizon: walk depth slices front to back; each slice is only
    // visible where it rises above everything drawn in front of it.
    const M = 520;
    const N = view.terrain === 'ridges' ? Math.max(8, Math.round(view.ridgeCount)) : 180;
    const H = new Float64Array(M).fill(-Infinity);
    const us = Array.from({ length: M }, (_, j) => u0 + ((u1 - u0) * j) / (M - 1));
    const vs = new Float64Array(M);
    // For the outline, only terrain near the runs counts, so the silhouette
    // wraps the skiable mountain instead of the surrounding plain.
    const massOnly = view.terrain === 'outline';
    const reach = Math.max(250, (u1 - u0) * 0.12);
    const dist = massOnly ? runDistance(model, reach * 2) : null;
    const minRise = Math.max(1, model.topElevation - zBase) * 0.03;
    for (let i = 0; i < N; i++) {
      const d = d0 + ((d1 - d0) * i) / (N - 1);
      for (let j = 0; j < M; j++) {
        const x = us[j] * r[0] + d * f[0];
        const y = us[j] * r[1] + d * f[1];
        let z = zAt(x, y);
        if (massOnly) {
          // Ease the terrain down away from the runs so the silhouette wraps the
          // skiable mountain instead of the surrounding plain.
          z = zBase + (z - zBase) * (1 - smoothstep(reach * 0.35, reach, dist(x, y)));
          vs[j] = z - zBase < minRise ? -Infinity : project(x, y, z)[1];
        } else {
          vs[j] = project(x, y, z)[1];
        }
      }
      if (view.terrain === 'ridges') {
        let cur = null;
        for (let j = 0; j < M; j++) {
          const vis = vs[j] > H[j] + 1e-6;
          if (vis) {
            if (!cur) {
              cur = [];
              terrain.push(cur);
              if (j > 0) cur.push(crossing(us, vs, H, j));
            }
            cur.push([us[j], vs[j]]);
          } else if (cur) {
            cur.push(crossing(us, vs, H, j));
            cur = null;
          }
        }
      }
      for (let j = 0; j < M; j++) if (vs[j] > H[j]) H[j] = vs[j];
    }
    if (massOnly) {
      // Break the silhouette where it jumps (an occlusion edge) rather than
      // drawing a vertical cliff, then soften it.
      const span = Math.max(...H.filter(Number.isFinite)) - Math.min(...H.filter(Number.isFinite));
      let cur = null;
      for (let j = 0; j < M; j++) {
        const ok = Number.isFinite(H[j]);
        if (ok && cur && Math.abs(H[j] - H[j - 1]) > span * 0.04) cur = null;
        if (ok) {
          if (!cur) terrain.push((cur = []));
          cur.push([us[j], H[j]]);
        } else {
          cur = null;
        }
      }
      terrain = terrain.filter((l) => l.length > M * 0.04).map((l) => chaikin(l, 2));
    }
    terrain = terrain.filter((l) => l.length >= 2).map((l) => simplify(l, (u1 - u0) * 0.0004));
  }

  return finish(trails, lifts, terrain, true);
}

// Point where the slice crosses the horizon between columns j-1 and j.
function crossing(us, vs, H, j) {
  const a = vs[j - 1] - H[j - 1];
  const b = vs[j] - H[j];
  const t = Number.isFinite(a) && Number.isFinite(b) && a !== b ? a / (a - b) : 0.5;
  return [us[j - 1] + (us[j] - us[j - 1]) * t, vs[j - 1] + (vs[j] - vs[j - 1]) * t];
}

function buildMap(model, dem, view) {
  const { f, r } = frame(view.azimuth);
  const rot = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]];

  const trails = model.runs.map((run) => ({
    name: run.name,
    difficulty: run.difficulty,
    lines: [prepRunPts(run, view.smooth).map(rot)],
  }));
  const lifts = view.showLifts
    ? model.lifts.map((lift) => {
        const pts = lift.pts.map(rot);
        return { name: lift.name, lines: [pts], stations: [pts[0], pts[pts.length - 1]] };
      })
    : [];

  let terrain = [];
  if (view.terrain === 'contours') {
    const range = Math.max(50, model.topElevation - model.baseElevation);
    const interval = view.contourInterval > 0 ? view.contourInterval : niceInterval(range * 1.4, 16);
    const start = Math.ceil(dem.min / interval) * interval;
    for (let level = start; level <= dem.max; level += interval) {
      for (const line of isolines(dem.data, dem.nx, dem.ny, level)) {
        const local = line.map(([i, j]) => [dem.x0 + i * dem.cell, dem.y0 + j * dem.cell]);
        terrain.push(simplify(chaikin(local, 1), dem.cell * 0.15).map(rot));
      }
    }
  }
  return finish(trails, lifts, terrain);
}

function finish(trails, lifts, terrain, terrainInFocus = false) {
  const focusLines = [...trails.flatMap((t) => t.lines), ...lifts.flatMap((l) => l.lines)];
  if (terrainInFocus) focusLines.push(...terrain);
  const focus = focusLines.length ? bounds(focusLines) : bounds(terrain);
  return { trails, lifts, terrain, focus };
}

/**
 * Approximate distance (m) to the nearest run, as a bilinear-sampled chamfer
 * distance field. Values are capped at `maxDist`.
 */
function runDistance(model, maxDist) {
  const pts = model.runs.flatMap((r) => r.pts);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  x0 -= maxDist; y0 -= maxDist; x1 += maxDist; y1 += maxDist;
  const n = 128;
  const cell = Math.max(x1 - x0, y1 - y0) / (n - 1);
  const g = new Float32Array(n * n).fill(maxDist);
  for (const run of model.runs) {
    for (const [x, y] of densify(run.pts, cell * 0.5)) {
      const i = Math.round((x - x0) / cell);
      const j = Math.round((y - y0) / cell);
      if (i >= 0 && j >= 0 && i < n && j < n) g[j * n + i] = 0;
    }
  }
  const a = cell;
  const b = cell * Math.SQRT2;
  const relax = (k, k2, w) => {
    if (g[k2] + w < g[k]) g[k] = g[k2] + w;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (i > 0) relax(k, k - 1, a);
      if (j > 0) {
        relax(k, k - n, a);
        if (i > 0) relax(k, k - n - 1, b);
        if (i < n - 1) relax(k, k - n + 1, b);
      }
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      if (i < n - 1) relax(k, k + 1, a);
      if (j < n - 1) {
        relax(k, k + n, a);
        if (i < n - 1) relax(k, k + n + 1, b);
        if (i > 0) relax(k, k + n - 1, b);
      }
    }
  }
  return (x, y) => {
    const fi = (x - x0) / cell;
    const fj = (y - y0) / cell;
    if (fi < 0 || fj < 0 || fi >= n - 1 || fj >= n - 1) return maxDist;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tx = fi - i;
    const ty = fj - j;
    const k = j * n + i;
    return (g[k] * (1 - tx) + g[k + 1] * tx) * (1 - ty) + (g[k + n] * (1 - tx) + g[k + n + 1] * tx) * ty;
  };
}

/** Uphill bearing (degrees from north) estimated from the runs: base → summit. */
export function uphillBearing(model, dem) {
  // Length-weighted average of each run's bottom → top direction.
  let sx = 0;
  let sy = 0;
  for (const run of model.runs) {
    let lo = null;
    let hi = null;
    for (const p of run.pts) {
      const z = dem.sample(p[0], p[1]);
      if (!lo || z < lo.z) lo = { p, z };
      if (!hi || z > hi.z) hi = { p, z };
    }
    if (!lo || hi.z - lo.z < 5) continue;
    const dx = hi.p[0] - lo.p[0];
    const dy = hi.p[1] - lo.p[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const w = (hi.z - lo.z) * len;
    sx += (dx / len) * w;
    sy += (dy / len) * w;
  }
  if (Math.hypot(sx, sy) < 1e-6) return 0;
  return ((Math.atan2(sx, sy) / RAD) + 360) % 360;
}
