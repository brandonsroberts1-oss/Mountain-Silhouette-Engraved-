// Fallback data source: OpenStreetMap via the Overpass API, plus Nominatim
// for search. Used when the OpenSkiMap API is unavailable.

import { polygonRings, pointInRing, bboxAround, geometryCenter } from './geo.js';
import { fetchWithTimeout, timeoutMs } from './net.js';

// Public Overpass servers. The main one is often busy, so if it hasn't
// answered within a few seconds the next mirror is asked in parallel and the
// first good answer wins (the others are cancelled).
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const LIFT_TYPES = 'chair_lift|gondola|cable_car|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow';

export function overpass(query, { signal, endpoints = ENDPOINTS } = {}) {
  const ctl = new AbortController();
  const cancel = () => ctl.abort();
  if (signal) signal.addEventListener('abort', cancel, { once: true });
  return new Promise((resolve, reject) => {
    const errors = [];
    const timers = [];
    let next = 0;
    let running = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (signal) signal.removeEventListener('abort', cancel);
      ctl.abort();
      fn(value);
    };
    const launch = () => {
      if (settled || next >= endpoints.length) return;
      const url = endpoints[next++];
      running++;
      fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctl.signal, kind: 'overpass' })
        .then((json) => {
          // Overpass reports query timeouts / overload as a 200 with a remark.
          if (json && json.remark && /error|timed out|out of memory/i.test(json.remark)) {
            throw new Error(`${new URL(url).host}: ${json.remark.trim()}`);
          }
          finish(resolve, json);
        })
        .catch((err) => {
          running--;
          if (settled) return;
          if (signal && signal.aborted) return finish(reject, new DOMException('Cancelled', 'AbortError'));
          errors.push(err);
          if (next < endpoints.length) launch();
          else if (running === 0) finish(reject, new Error(`OpenStreetMap (Overpass) failed: ${errors.map((e) => e.message).join('; ')}`));
        });
    };
    launch();
    // Hedge: bring in one more mirror each time the hedge delay passes in silence.
    for (let k = 1; k < endpoints.length; k++) timers.push(setTimeout(launch, timeoutMs('overpassHedge') * k));
  });
}

const geomCoords = (geom) => (geom || []).map((g) => [g.lon, g.lat]);

function isClosed(c) {
  return c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
}

/** Runs and lifts in a bbox, optionally limited to an area polygon. */
export async function fetchOverpassFeatures(area, bbox, { signal } = {}) {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  // Route relations are fetched without geometry; their member ways come back
  // once (with geometry) alongside the other ways, keeping the response small.
  const q = `[out:json][timeout:35];
way["piste:type"="downhill"](${b})->.runs;
way["aerialway"~"^(${LIFT_TYPES})$"](${b})->.lifts;
rel["piste:type"="downhill"]["type"="route"](${b})->.routes;
way(r.routes)->.members;
(.runs; .lifts; .members;);
out tags geom qt;
.routes out body qt;`;
  const data = await overpass(q, { signal });
  const elements = data.elements || [];
  const ways = new Map(elements.filter((e) => e.type === 'way').map((w) => [w.id, w]));
  const runs = [];
  const lifts = [];
  const used = new Set();
  for (const w of ways.values()) {
    const tags = w.tags || {};
    if (tags['piste:type'] === 'downhill') {
      const coords = geomCoords(w.geometry);
      if (coords.length < 2 || tags.area === 'yes' || isClosed(coords)) continue;
      used.add(w.id);
      runs.push({ name: tags['piste:name'] || tags.name || null, difficulty: tags['piste:difficulty'] || null, coords });
    } else if (tags.aerialway) {
      const coords = geomCoords(w.geometry);
      if (coords.length >= 2) lifts.push({ name: tags.name || null, type: tags.aerialway, coords });
    }
  }
  for (const rel of elements.filter((e) => e.type === 'relation')) {
    for (const m of rel.members || []) {
      if (m.type !== 'way' || used.has(m.ref) || !ways.has(m.ref)) continue;
      used.add(m.ref);
      const coords = geomCoords(ways.get(m.ref).geometry);
      if (coords.length < 2) continue;
      runs.push({ name: rel.tags['piste:name'] || rel.tags.name || null, difficulty: rel.tags['piste:difficulty'] || null, coords });
    }
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
  const results = await fetchWithTimeout(url, { signal, kind: 'search', headers: { Accept: 'application/json' } });
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
