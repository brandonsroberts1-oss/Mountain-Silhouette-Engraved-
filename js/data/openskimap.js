// OpenSkiMap API (https://openskimap.org): processed OpenStreetMap ski data
// with ski-area membership, statistics and reverse-geocoded places.

import { bboxOfCoords, expandBbox, bboxAround, bboxAreaKm2, polygonRings, geometryCenter } from './geo.js';
import { fetchWithTimeout } from './net.js';

const API = 'https://api.openskimap.org';

function getJson(url, signal, kind = 'api') {
  return fetchWithTimeout(url, { signal, kind, headers: { Accept: 'application/json' } });
}

function placeOf(props) {
  const p = (props.places || [])[0];
  if (!p) return null;
  const en = (p.localized && p.localized.en) || {};
  return { locality: en.locality || null, region: en.region || null, country: en.country || null, countryCode: p.iso3166_1Alpha2 || null };
}

function toArea(feature) {
  const p = feature.properties || {};
  const center = geometryCenter(feature.geometry);
  if (!center) return null;
  return {
    id: p.id,
    source: 'openskimap',
    name: p.name || 'Unnamed ski area',
    center,
    geometry: feature.geometry,
    place: placeOf(p),
    convention: p.runConvention || 'north_america',
    statistics: p.statistics || null,
    websites: p.websites || [],
    downhill: !p.activities || p.activities.includes('downhill'),
  };
}

/** Search ski areas by name. Runs/lifts that match contribute their ski area. */
export async function searchSkiAreas(query, { signal } = {}) {
  const features = await getJson(`${API}/search?query=${encodeURIComponent(query)}`, signal, 'search');
  const out = new Map();
  for (const f of features || []) {
    const p = f.properties || {};
    if (p.type === 'skiArea') {
      const a = toArea(f);
      if (a && !out.has(a.id)) out.set(a.id, a);
    }
  }
  for (const f of features || []) {
    const p = f.properties || {};
    if (p.type === 'run' || p.type === 'lift') {
      for (const sa of p.skiAreas || []) {
        const a = toArea(sa);
        if (a && sa.properties && sa.properties.name && !out.has(a.id)) {
          a.partial = true;
          out.set(a.id, a);
        }
      }
    }
  }
  return [...out.values()].filter((a) => a.downhill);
}

/** Full ski-area feature (statistics, places) by id. */
export async function getSkiArea(id, { signal } = {}) {
  const f = await getJson(`${API}/features/${encodeURIComponent(id)}.geojson`, signal);
  return toArea(f);
}

export function areaBbox(area) {
  const rings = polygonRings(area.geometry);
  if (rings.length) {
    let b = expandBbox(bboxOfCoords(rings), 0.15, 300);
    if (bboxAreaKm2(b) > 900) b = bboxAround(area.center, 12000);
    return b;
  }
  // Point-only areas: search wide and rely on ski-area membership to filter.
  return bboxAround(area.center, 7000);
}

function lineCoords(geometry) {
  if (!geometry) return [];
  const strip = (cs) => cs.map((c) => [c[0], c[1]]);
  if (geometry.type === 'LineString') return [strip(geometry.coordinates)];
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map(strip);
  return [];
}

const SKIP_LIFTS = new Set(['magic_carpet', 'zip_line', 'funicular', 'railway', 'rack_railway', 'canopy']);

/** Runs and lifts belonging to a ski area. */
export async function fetchAreaFeatures(area, { signal } = {}) {
  const b = areaBbox(area);
  const url = `${API}/features.geojson?bbox=${[b.minLon, b.minLat, b.maxLon, b.maxLat].map((v) => v.toFixed(5)).join(',')}&types=run,lift`;
  const fc = await getJson(url, signal);
  const feats = (fc && fc.features) || [];
  const belongs = (p) => (p.skiAreas || []).some((sa) => sa.properties && sa.properties.id === area.id);

  const runFeats = feats.filter((f) => f.properties.type === 'run' && (f.properties.uses || []).includes('downhill'));
  const liftFeats = feats.filter((f) => f.properties.type === 'lift' && !SKIP_LIFTS.has(f.properties.liftType));
  const mine = runFeats.filter((f) => belongs(f.properties));
  const runsSrc = mine.length ? mine : runFeats;
  const liftsMine = liftFeats.filter((f) => belongs(f.properties));
  const liftsSrc = mine.length ? liftsMine : liftFeats;

  const runs = [];
  for (const f of runsSrc) {
    for (const coords of lineCoords(f.geometry)) {
      if (coords.length < 2) continue;
      runs.push({ name: f.properties.name || null, difficulty: f.properties.difficulty || null, coords });
    }
  }
  if (!runs.length) {
    // Some areas only map pistes as polygons; use their outlines.
    for (const f of runsSrc) {
      for (const ring of polygonRings(f.geometry)) {
        runs.push({ name: f.properties.name || null, difficulty: f.properties.difficulty || null, coords: ring.map((c) => [c[0], c[1]]) });
      }
    }
  }
  const lifts = [];
  for (const f of liftsSrc) {
    for (const coords of lineCoords(f.geometry)) {
      if (coords.length < 2) continue;
      lifts.push({ name: f.properties.name || null, type: f.properties.liftType || null, coords });
    }
  }
  return { runs, lifts, source: 'OpenSkiMap' };
}
