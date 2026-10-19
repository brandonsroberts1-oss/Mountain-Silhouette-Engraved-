// Fallback data source: OpenStreetMap via the Overpass API, plus Nominatim
// for search. Used when the OpenSkiMap API is unavailable.

import { polygonRings, pointInRing, bboxAround, geometryCenter } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const LIFT_TYPES = 'chair_lift|gondola|cable_car|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow';

async function overpass(query, signal) {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal,
      });
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

const geomCoords = (geom) => (geom || []).map((g) => [g.lon, g.lat]);

function isClosed(c) {
  return c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
}

/** Runs and lifts in a bbox, optionally limited to an area polygon. */
export async function fetchOverpassFeatures(area, bbox, { signal } = {}) {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  const q = `[out:json][timeout:90];
(
  way["piste:type"="downhill"](${b});
  relation["piste:type"="downhill"]["type"="route"](${b});
  way["aerialway"~"^(${LIFT_TYPES})$"](${b});
);
out tags geom;`;
  const data = await overpass(q, signal);
  const runs = [];
  const lifts = [];
  const seen = new Set();
  const runWays = (data.elements || []).filter((e) => e.type === 'way' && e.tags && e.tags['piste:type'] === 'downhill');
  for (const w of runWays) {
    const coords = geomCoords(w.geometry);
    if (coords.length < 2 || w.tags.area === 'yes' || isClosed(coords)) continue;
    seen.add(w.id);
    runs.push({ name: w.tags['piste:name'] || w.tags.name || null, difficulty: w.tags['piste:difficulty'] || null, coords });
  }
  for (const rel of (data.elements || []).filter((e) => e.type === 'relation')) {
    for (const m of rel.members || []) {
      if (m.type !== 'way' || seen.has(m.ref) || !m.geometry) continue;
      seen.add(m.ref);
      const coords = geomCoords(m.geometry);
      if (coords.length < 2) continue;
      runs.push({ name: rel.tags['piste:name'] || rel.tags.name || null, difficulty: rel.tags['piste:difficulty'] || null, coords });
    }
  }
  for (const w of (data.elements || []).filter((e) => e.type === 'way' && e.tags && e.tags.aerialway)) {
    const coords = geomCoords(w.geometry);
    if (coords.length >= 2) lifts.push({ name: w.tags.name || null, type: w.tags.aerialway, coords });
  }

  // Keep only what lies in the ski area (any vertex inside its polygon).
  const rings = polygonRings(area && area.geometry);
  const inside = (f) => !rings.length || f.coords.some((c) => rings.some((r) => pointInRing(c, r)));
  return { runs: runs.filter(inside), lifts: lifts.filter(inside), source: 'OpenStreetMap (Overpass)' };
}

/** Nominatim search, preferring landuse=winter_sports results. */
export async function nominatimSearch(query, { signal } = {}) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&polygon_geojson=1&limit=10&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} from nominatim.openstreetmap.org`);
  const results = await res.json();
  const score = (r) => (r.type === 'winter_sports' ? 2 : r.category === 'natural' || r.category === 'leisure' ? 1 : 0);
  return results
    .sort((a, b) => score(b) - score(a))
    .map((r) => {
      const geometry = r.geojson && /Polygon/.test(r.geojson.type) ? r.geojson : { type: 'Point', coordinates: [+r.lon, +r.lat] };
      const addr = r.address || {};
      const cc = (addr.country_code || '').toUpperCase();
      return {
        id: `osm-${r.osm_type}-${r.osm_id}`,
        source: 'nominatim',
        name: r.name || r.display_name.split(',')[0],
        center: geometryCenter(geometry) || [+r.lon, +r.lat],
        geometry,
        place: { locality: addr.village || addr.town || addr.city || null, region: addr.state || addr.county || null, country: addr.country || null, countryCode: cc || null },
        convention: cc === 'US' || cc === 'CA' ? 'north_america' : cc === 'JP' ? 'japan' : 'europe',
        statistics: null,
        winterSports: r.type === 'winter_sports',
      };
    });
}

export { bboxAround };
