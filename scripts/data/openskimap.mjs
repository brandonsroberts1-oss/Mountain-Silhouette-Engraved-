// Reader for OpenSkiMap's published GeoJSON downloads (https://openskidata.org):
// ski_areas.geojson, runs.geojson (~1 GB) and lifts.geojson.

import { norm, r5, packLine, bboxCenter, readStream } from './common.mjs';

export const SOURCE = {
  name: 'OpenSkiMap',
  url: 'https://openskimap.org',
  attribution: 'Data © OpenStreetMap contributors (ODbL) and Skimap.org, processed by OpenSkiMap (openskidata.org)',
  license:
    'This directory contains data derived from OpenSkiMap (https://openskimap.org, https://openskidata.org),\n' +
    'which combines OpenStreetMap and Skimap.org data.\n\n',
};

export const FILES = ['ski_areas.geojson', 'runs.geojson', 'lifts.geojson'];

const SKIP_LIFTS = new Set(['magic_carpet', 'zip_line', 'funicular', 'railway', 'rack_railway', 'canopy', 'platter_station']);

// Streaming FeatureCollection reader: yields each object found directly inside
// the top-level "features" array, without loading the whole file.
async function* features(stream) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let capturing = false;
  let parts = [];
  let start = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (inString) {
        if (escape) escape = false;
        else if (c === 0x5c) escape = true; // backslash
        else if (c === 0x22) inString = false; // quote
        continue;
      }
      if (c === 0x22) {
        inString = true;
      } else if (c === 0x7b || c === 0x5b) {
        // { or [
        if (c === 0x7b && depth === 2 && !capturing) {
          capturing = true;
          parts = [];
          start = i;
        }
        depth++;
      } else if (c === 0x7d || c === 0x5d) {
        depth--;
        if (capturing && depth === 2) {
          parts.push(buf.subarray(start, i + 1));
          capturing = false;
          yield JSON.parse(Buffer.concat(parts).toString('utf8'));
        }
      }
    }
    if (capturing) parts.push(Buffer.from(buf.subarray(start)));
  }
}

function lines(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function rings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => p[0]);
  return [];
}

const areaIds = (p) => (p.skiAreas || []).map((sa) => (typeof sa === 'string' ? sa : sa && sa.properties && sa.properties.id)).filter(Boolean);

/**
 * files: [ski_areas, runs, lifts] paths. Returns { areas, buckets }:
 * index entries by id, and each area's runs / area-runs / lifts as JSON strings.
 */
export async function readOpenSkiMap([skiAreasFile, runsFile, liftsFile], { only = null } = {}) {
  const t0 = Date.now();
  const areas = new Map();
  const buckets = new Map();
  const bucket = (id) => {
    if (!buckets.has(id)) buckets.set(id, { runs: [], areaRuns: [], lifts: [] });
    return buckets.get(id);
  };

  for await (const f of features(readStream(skiAreasFile))) {
    const p = f.properties || {};
    if (!p.id || !p.name) continue;
    if (p.activities && !p.activities.includes('downhill')) continue;
    if (only && !only.some((q) => norm(p.name).includes(q))) continue;
    const c = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : bboxCenter(rings(f.geometry));
    if (!c) continue;
    const place = (p.places || [])[0] || {};
    const en = (place.localized && place.localized.en) || {};
    const st = p.statistics || {};
    areas.set(p.id, {
      id: p.id,
      name: p.name,
      lon: r5(c[0]),
      lat: r5(c[1]),
      locality: en.locality || '',
      region: en.region || '',
      country: en.country || '',
      cc: place.iso3166_1Alpha2 || '',
      conv: p.runConvention || 'north_america',
      minE: Number.isFinite(st.minElevation) ? Math.round(st.minElevation) : null,
      maxE: Number.isFinite(st.maxElevation) ? Math.round(st.maxElevation) : null,
      web: (p.websites || [])[0] || '',
    });
  }
  console.log(`ski areas: ${areas.size} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  let nRuns = 0;
  for await (const f of features(readStream(runsFile))) {
    const p = f.properties || {};
    if (!(p.uses || []).includes('downhill')) continue;
    const ids = areaIds(p).filter((id) => areas.has(id));
    if (!ids.length) continue;
    const name = p.name || null;
    const difficulty = p.difficulty || null;
    const ls = lines(f.geometry).map(packLine).filter((l) => l.length >= 2);
    const rs = ls.length ? [] : rings(f.geometry).map(packLine).filter((l) => l.length >= 3);
    for (const id of ids) {
      for (const l of ls) bucket(id).runs.push(JSON.stringify({ n: name, d: difficulty, c: l }));
      for (const r of rs) bucket(id).areaRuns.push(JSON.stringify({ n: name, d: difficulty, c: r }));
    }
    if (++nRuns % 50000 === 0) console.log(`  runs: ${nRuns}`);
  }
  console.log(`downhill runs: ${nRuns} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  let nLifts = 0;
  for await (const f of features(readStream(liftsFile))) {
    const p = f.properties || {};
    if (SKIP_LIFTS.has(p.liftType)) continue;
    if (p.status && p.status !== 'operating') continue;
    const ids = areaIds(p).filter((id) => areas.has(id));
    if (!ids.length) continue;
    const ls = lines(f.geometry).map(packLine).filter((l) => l.length >= 2);
    for (const id of ids) for (const l of ls) bucket(id).lifts.push(JSON.stringify({ n: p.name || null, t: p.liftType || null, c: l }));
    nLifts++;
  }
  console.log(`lifts: ${nLifts} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { areas, buckets };
}
