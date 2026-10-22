// OpenSkiMap API (https://openskimap.org): processed OpenStreetMap ski data
// with ski-area membership, statistics and reverse-geocoded places.

import { bboxOfCoords, expandBbox, bboxAround, bboxAreaKm2, polygonRings, geometryCenter, pointInRing } from './geo.js';
import { fetchWithTimeout } from './net.js';
import { decodeTile, maybeGunzip } from './mvt.js';
import { clipPolyline } from '../render/geometry.js';

const API = 'https://api.openskimap.org';
const TILES = 'https://tiles.openskimap.org';

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

// ---------------------------------------------------------------------------
// OpenSkiMap vector tiles: the same CDN-served data openskimap.org draws its
// map from (layers "runs" and "lifts", with ski-area ids on each feature).

let templatePromise = null;

/** Find the vector tile URL template that carries the "runs" layer. */
function tileTemplate(signal) {
  if (!templatePromise) {
    templatePromise = discoverTemplate(signal).catch((err) => {
      templatePromise = null;
      throw err;
    });
  }
  return templatePromise;
}

async function discoverTemplate(signal) {
  const hasRuns = (tj) => Array.isArray(tj && tj.tiles) && tj.tiles.length && (!tj.vector_layers || tj.vector_layers.some((l) => l.id === 'runs'));
  const fromTileJson = async (url) => {
    const tj = await getJson(url, signal);
    if (!hasRuns(tj)) throw new Error('no runs layer');
    return tj.tiles[0];
  };
  const fromStyle = async (style) => {
    const st = await getJson(`${TILES}/styles/${style}.json`, signal);
    for (const [id, src] of Object.entries(st.sources || {})) {
      if (src.type !== 'vector') continue;
      const usesRuns = (st.layers || []).some((l) => l.source === id && l['source-layer'] === 'runs');
      if (src.tiles && src.tiles.length && usesRuns) return src.tiles[0];
      if (src.url && /^https?:/.test(src.url)) {
        try {
          return await fromTileJson(src.url);
        } catch (err) {
          if (err.name === 'AbortError') throw err;
        }
      }
    }
    throw new Error('no runs source');
  };
  // Ask the likely locations at once; the first that describes a "runs" layer wins.
  try {
    return await Promise.any([fromTileJson(`${TILES}/data/openskimap.json`), fromStyle('terrain_v2'), fromStyle('satellite_v2')]);
  } catch (err) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const reasons = (err.errors || [err]).map((e) => e.message);
    throw new Error(`map tiles unavailable (${[...new Set(reasons)].join('; ')})`);
  }
}

const lonOf = (tx, z) => (tx / 2 ** z) * 360 - 180;
const latOf = (ty, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI;
const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

/**
 * Runs and lifts of a ski area from OpenSkiMap's vector tiles. Each tile's
 * lines are clipped to the tile's exact square, so the pieces of a run that
 * crosses tile edges meet end to end and are re-joined later.
 */
export async function fetchAreaFeaturesFromTiles(area, { signal, onProgress = () => {} } = {}) {
  const template = await tileTemplate(signal);
  const b = areaBbox(area);
  let z = 14;
  let tiles = [];
  for (; z >= 12; z--) {
    tiles = [];
    for (let x = tileX(b.minLon, z); x <= tileX(b.maxLon, z); x++) {
      for (let y = tileY(b.maxLat, z); y <= tileY(b.minLat, z); y++) tiles.push([x, y]);
    }
    if (tiles.length <= 30) break;
  }
  let done = 0;
  let failed = 0;
  const decoded = await pool(tiles, 6, async ([x, y]) => {
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    try {
      const buf = await fetchWithTimeout(url, { signal, kind: 'tile', parse: 'arrayBuffer' });
      return { x, y, layers: decodeTile(await maybeGunzip(buf)) };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.status !== 404) failed++;
      return null;
    } finally {
      onProgress(`Fetching trails from OpenSkiMap… ${++done}/${tiles.length} tiles`);
    }
  });
  if (failed === tiles.length) throw new Error('OpenSkiMap map tiles could not be downloaded');

  const runs = [];
  const runAreas = [];
  const lifts = [];
  for (const t of decoded) {
    if (!t) continue;
    for (const [name, layer] of Object.entries(t.layers)) {
      if (name !== 'runs' && name !== 'lifts') continue;
      const ext = layer.extent;
      const square = { shape: { type: 'rect', x: 0, y: 0, w: ext, h: ext } };
      const toLonLat = ([px, py]) => [lonOf(t.x + px / ext, z), latOf(t.y + py / ext, z)];
      for (const f of layer.features) {
        const p = f.properties;
        const inArea = String(p.skiAreas || '').includes(area.id);
        if (name === 'runs') {
          if (p.downhill == null) continue; // nordic, skitour, sled…
          if (f.type === 'LineString') {
            for (const line of f.geometry) {
              for (const piece of clipPolyline(line, square)) runs.push({ name: p.name || null, difficulty: p.difficulty || null, coords: piece.map(toLonLat), inArea });
            }
          } else if (f.type === 'Polygon') {
            for (const ring of f.geometry) runAreas.push({ name: p.name || null, difficulty: p.difficulty || null, coords: ring.map(toLonLat), inArea });
          }
        } else if (f.type === 'LineString' && (!p.status || p.status === 'operating')) {
          for (const line of f.geometry) {
            for (const piece of clipPolyline(line, square)) lifts.push({ name: p.name_and_type || null, type: null, coords: piece.map(toLonLat), inArea });
          }
        }
      }
    }
  }

  // Prefer exact ski-area membership; otherwise keep what lies in the area.
  const rings = polygonRings(area.geometry);
  const nearby = (f) => !rings.length || f.coords.some((c) => rings.some((r) => pointInRing(c, r)));
  const pick = (list) => {
    const mine = list.filter((f) => f.inArea);
    return (mine.length ? mine : list.filter(nearby)).map(({ inArea, ...f }) => f);
  };
  const lineRuns = pick(runs);
  return {
    runs: lineRuns.length ? lineRuns : pick(runAreas),
    lifts: pick(lifts),
    source: 'OpenSkiMap map tiles',
  };
}
