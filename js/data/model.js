// Converts fetched runs/lifts into a local-metre model and derives the stats
// printed on the design.

import { makeProjection, bboxOfCoords } from './geo.js';
import { polylineLength } from '../render/geometry.js';
import { difficultyRank, difficultyClass, DIFFICULTY_ORDER } from '../format.js';

export function buildModel(features) {
  const all = [...features.runs.map((r) => r.coords), ...features.lifts.map((l) => l.coords)];
  const b = bboxOfCoords(all);
  const center = [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2];
  const proj = makeProjection(center[0], center[1]);
  const runs = joinRuns(features.runs.map((r) => ({ name: r.name, difficulty: r.difficulty, pts: r.coords.map(proj.toLocal) })))
    .filter((r) => polylineLength(r.pts) >= 40);
  const lifts = features.lifts
    .map((l) => ({ name: l.name, type: l.type, pts: l.coords.map(proj.toLocal) }))
    .filter((l) => polylineLength(l.pts) >= 40);
  let maxDist = 0;
  for (const f of [...runs, ...lifts]) for (const [x, y] of f.pts) maxDist = Math.max(maxDist, Math.hypot(x, y));
  return { proj, center, runs, lifts, radius: Math.max(700, maxDist * 1.32) };
}

/**
 * OpenStreetMap splits a run into many ways (at every junction or tag change).
 * Chain segments of the same run end-to-end so each trail draws as one
 * continuous stroke. Named segments join by name; unnamed ones by difficulty.
 */
export function joinRuns(runs, tolerance = 20) {
  const groups = new Map();
  for (const r of runs) {
    if (r.pts.length < 2) continue;
    const key = r.name ? `n:${r.name.trim().toLowerCase()}` : `u:${r.difficulty || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: r.name ? r.name.trim() : null, difficulty: r.difficulty, pts: r.pts.slice() });
  }
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
  const out = [];
  for (const chains of groups.values()) {
    // Grow each chain until nothing else attaches to either end: O(n²) per group.
    for (let i = 0; i < chains.length; i++) {
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < chains.length; j++) {
          if (j === i) continue;
          const a = chains[i].pts;
          const b = chains[j].pts;
          let joined = null;
          if (close(a[a.length - 1], b[0])) joined = [...a, ...b.slice(1)];
          else if (close(a[a.length - 1], b[b.length - 1])) joined = [...a, ...b.slice(0, -1).reverse()];
          else if (close(a[0], b[b.length - 1])) joined = [...b, ...a.slice(1)];
          else if (close(a[0], b[0])) joined = [...b.slice(1).reverse(), ...a];
          if (!joined) continue;
          const d = difficultyRank(chains[j].difficulty) > difficultyRank(chains[i].difficulty) ? chains[j].difficulty : chains[i].difficulty;
          chains[i] = { ...chains[i], difficulty: d, pts: joined };
          chains.splice(j, 1);
          if (j < i) i--;
          grew = true;
          break;
        }
      }
    }
    out.push(...chains);
  }
  return out;
}

/** Fill in base/top elevation from the DEM along the runs. */
export function attachElevation(model, dem) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of model.runs) {
    for (const [x, y] of r.pts) {
      const z = dem.sample(x, y);
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  model.baseElevation = Number.isFinite(lo) ? lo : dem.min;
  model.topElevation = Number.isFinite(hi) ? hi : dem.max;
  return model;
}

/** Group run segments into trails: by name; unnamed segments count if long enough. */
export function groupTrails(runs, minUnnamedLength = 250) {
  const named = new Map();
  const unnamed = [];
  for (const r of runs) {
    const len = r.lengthM ?? polylineLength(r.pts);
    const key = r.name ? r.name.trim().toLowerCase() : '';
    if (key) {
      const t = named.get(key) || { name: r.name.trim(), difficulty: null, length: 0 };
      if (difficultyRank(r.difficulty) > difficultyRank(t.difficulty)) t.difficulty = r.difficulty;
      t.length += len;
      named.set(key, t);
    } else if (len >= minUnnamedLength) {
      unnamed.push({ name: null, difficulty: r.difficulty, length: len });
    }
  }
  return [...named.values(), ...unnamed];
}

export function computeStats(area, model, dem) {
  const trails = groupTrails(model.runs);
  const byClass = { easy: 0, intermediate: 0, advanced: 0, expert: 0, other: 0 };
  let maxDifficulty = null;
  for (const t of trails) {
    byClass[difficultyClass(t.difficulty)]++;
    if (difficultyRank(t.difficulty) > difficultyRank(maxDifficulty)) maxDifficulty = t.difficulty;
  }

  // Summit / base: highest and lowest points reached by runs or lifts.
  let top = { z: -Infinity, p: null };
  let base = { z: Infinity, p: null };
  for (const f of [...model.runs, ...model.lifts]) {
    for (const p of f.pts) {
      const z = dem.sample(p[0], p[1]);
      if (z > top.z) top = { z, p };
      if (z < base.z) base = { z, p };
    }
  }
  const st = area.statistics || {};
  const summit = Number.isFinite(st.maxElevation) ? st.maxElevation : top.z;
  const baseElev = Number.isFinite(st.minElevation) ? st.minElevation : base.z;

  const totalKm = model.runs.reduce((a, r) => a + polylineLength(r.pts), 0) / 1000;
  const named = trails.filter((t) => t.name).map((t) => t.name).sort((a, b) => a.localeCompare(b));

  return {
    summit,
    base: baseElev,
    vertical: summit - baseElev,
    trailCount: trails.length,
    liftCount: model.lifts.length,
    maxDifficulty,
    byClass,
    totalKm,
    trailNames: named,
    summitLonLat: top.p ? model.proj.toLonLat(top.p) : model.center,
    baseLonLat: base.p ? model.proj.toLonLat(base.p) : model.center,
    centerLonLat: area.center || model.center,
  };
}

export { DIFFICULTY_ORDER };
