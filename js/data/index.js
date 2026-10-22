// Data facade: search + load a ski area with graceful fallbacks.

import { searchSkiAreas, getSkiArea, fetchAreaFeatures, fetchAreaFeaturesFromTiles, areaBbox } from './openskimap.js';
import { polygonRings, bboxAround } from './geo.js';
import { fetchOverpassFeatures, nominatimSearch } from './overpass.js';
import { buildModel, attachElevation, computeStats } from './model.js';
import { loadDem } from './dem.js';

export async function search(query, { signal } = {}) {
  let primaryError = null;
  try {
    const results = await searchSkiAreas(query, { signal });
    if (results.length) return { results, source: 'OpenSkiMap' };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    primaryError = err;
  }
  try {
    const results = await nominatimSearch(query, { signal });
    return { results, source: 'OpenStreetMap Nominatim', warning: primaryError ? `OpenSkiMap unavailable (${primaryError.message})` : null };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw primaryError || err;
  }
}

/**
 * Load everything needed to draw an area.
 * onProgress(message) is called as steps complete.
 */
export async function loadArea(area, { signal, onProgress = () => {} } = {}) {
  if (area.source === 'openskimap' && area.partial) {
    try {
      area = { ...(await getSkiArea(area.id, { signal })), partial: false };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }

  // Trail sources, fastest and most specific first. Each has its own deadline,
  // so a slow server moves on to the next source instead of hanging.
  const sources = [];
  if (area.source === 'openskimap') {
    sources.push(['OpenSkiMap', 'Fetching trails from OpenSkiMap…', () => fetchAreaFeatures(area, { signal })]);
  }
  sources.push(['OpenSkiMap map tiles', 'Fetching trails from OpenSkiMap map tiles…', () => fetchAreaFeaturesFromTiles(area, { signal, onProgress })]);
  sources.push(['OpenStreetMap', 'Fetching trails from OpenStreetMap (Overpass)…', () => {
    // Without a ski-area polygon there's no membership filter, so stay close to the point.
    const bbox = polygonRings(area.geometry).length ? areaBbox(area) : bboxAround(area.center, 3500);
    return fetchOverpassFeatures(area, bbox, { signal });
  }]);

  let features = null;
  const notes = [];
  for (const [name, message, load] of sources) {
    onProgress(message);
    try {
      const f = await load();
      if (f.runs.length) {
        features = f;
        break;
      }
      notes.push(`${name}: no downhill runs found`);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      notes.push(`${name}: ${err.message}`);
    }
  }
  if (!features) {
    throw new Error(`no trail data could be loaded (${notes.join(' · ')})`);
  }

  const model = buildModel(features);
  onProgress('Loading terrain…');
  const dem = await loadDem(model.proj, model.radius * Math.SQRT2 * 1.03, { signal });
  attachElevation(model, dem);
  const stats = computeStats(area, model, dem);
  return { area, features, model, dem, stats, notes };
}
