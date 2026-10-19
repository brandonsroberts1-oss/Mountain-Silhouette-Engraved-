// Data facade: search + load a ski area with graceful fallbacks.

import { searchSkiAreas, getSkiArea, fetchAreaFeatures, areaBbox } from './openskimap.js';
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

  onProgress('Fetching trails and lifts…');
  let features = null;
  const notes = [];
  if (area.source === 'openskimap') {
    try {
      features = await fetchAreaFeatures(area, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      notes.push(`OpenSkiMap features unavailable (${err.message}); using Overpass.`);
    }
  }
  if (!features || !features.runs.length) {
    onProgress('Fetching trails from OpenStreetMap…');
    // Without a ski-area polygon there's no membership filter, so stay close to the point.
    const bbox = polygonRings(area.geometry).length ? areaBbox(area) : bboxAround(area.center, 3500);
    features = await fetchOverpassFeatures(area, bbox, { signal });
  }
  if (!features.runs.length) {
    throw new Error('No downhill runs are mapped for this place in OpenStreetMap.');
  }

  const model = buildModel(features);
  onProgress('Loading terrain…');
  const dem = await loadDem(model.proj, model.radius * Math.SQRT2 * 1.03, { signal });
  attachElevation(model, dem);
  const stats = computeStats(area, model, dem);
  return { area, features, model, dem, stats, notes };
}
