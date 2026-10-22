// Self-hosted trail data, published next to the app by the GitHub Pages
// workflow (scripts/build-data.mjs). Same-origin, so it works whatever
// third-party services the visitor's network or browser can reach.

import { fetchWithTimeout } from './net.js';

const BASE = new URL('../../data/', import.meta.url);
let indexPromise = null;
let indexMeta = null;

/** { built, count } of the bundled data, once the index has loaded. */
export function bundledInfo() {
  return indexMeta;
}

function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The search index, or null when this deployment has no bundled data. */
export function loadIndex(signal) {
  if (!indexPromise) {
    indexPromise = fetchWithTimeout(new URL('index.json', BASE).href, { kind: 'api', signal })
      .then((meta) => {
        indexMeta = { built: meta.built, count: meta.areas.length };
        const at = Object.fromEntries(meta.fields.map((f, i) => [f, i]));
        return meta.areas.map((row) => {
          const area = toArea(row, at);
          area.key = norm(area.name);
          area.placeKey = norm([area.place.locality, area.place.region, area.place.country].join(' '));
          return area;
        });
      })
      .catch((err) => {
        indexPromise = null;
        if (err.name === 'AbortError') throw err;
        return null;
      });
  }
  return indexPromise;
}

function toArea(row, at) {
  const center = [row[at.lon], row[at.lat]];
  return {
    id: row[at.id],
    source: 'local',
    name: row[at.name],
    center,
    geometry: { type: 'Point', coordinates: center },
    place: { locality: row[at.locality] || null, region: row[at.region] || null, country: row[at.country] || null, countryCode: row[at.cc] || null },
    convention: row[at.convention] || 'north_america',
    statistics: { minElevation: row[at.minElevation] ?? undefined, maxElevation: row[at.maxElevation] ?? undefined },
    runCount: row[at.runs] || 0,
    websites: row[at.website] ? [row[at.website]] : [],
    downhill: true,
  };
}

/** Rank index entries for a query: name matches first, then place matches. */
export function rankAreas(index, query, limit = 10) {
  const q = norm(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const scored = [];
  for (const a of index) {
    const words = a.key.split(' ');
    let score = 0;
    if (a.key === q) score = 100;
    else if (a.key.startsWith(q)) score = 85;
    else if (tokens.every((t) => words.some((w) => w.startsWith(t)))) score = 70;
    else if (a.key.includes(q)) score = 55;
    else if (tokens.every((t) => words.some((w) => w.startsWith(t)) || a.placeKey.split(' ').some((w) => w.startsWith(t)))) score = 40;
    if (!score) continue;
    // Bigger resorts first among equal matches.
    scored.push([score + Math.min(9, Math.log10(a.runCount + 1) * 4), a]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => a);
}

export async function searchLocal(query, { signal } = {}) {
  const index = await loadIndex(signal);
  return index ? rankAreas(index, query) : null;
}

/** Runs and lifts of a bundled ski area, or null if this area isn't bundled. */
export async function fetchLocalArea(area, { signal } = {}) {
  const index = await loadIndex(signal);
  if (!index) return null;
  // Ids change when OpenSkiMap re-processes data, so an area saved earlier is
  // matched again by name and position.
  let entry = index.find((a) => a.id === area.id);
  if (!entry && area.name && area.center) {
    const key = norm(area.name);
    const near = (a) => Math.hypot(a.center[0] - area.center[0], (a.center[1] - area.center[1]) * 1.5) < 0.25;
    entry = index.find((a) => a.key === key && near(a)) || index.find((a) => (a.key.includes(key) || key.includes(a.key)) && near(a));
  }
  if (!entry) return null;
  const data = await fetchWithTimeout(new URL(`areas/${encodeURIComponent(entry.id)}.json`, BASE).href, { kind: 'api', signal });
  return {
    area: entry,
    runs: data.runs.map((r) => ({ name: r.n, difficulty: r.d, coords: r.c })),
    lifts: data.lifts.map((l) => ({ name: l.n, type: l.t, coords: l.c })),
    source: 'bundled OpenSkiMap data',
  };
}
