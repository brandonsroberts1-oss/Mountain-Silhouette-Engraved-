// State / province and country for a point, from Natural Earth's admin-1
// boundaries (public domain). Fills in place names for ski areas whose
// source data has none (the OpenSnowMap fallback).

import fs from 'node:fs';
import { pointInRing } from '../../js/data/geo.js';

export const DEFAULT_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';

/** Returns lookup([lon, lat]) -> { region, country, cc } or null. */
export function adminLookup(file) {
  const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cell = 1;
  const grid = new Map();
  for (const f of geo.features || []) {
    const g = f.geometry;
    const p = f.properties || {};
    const polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const iso = String(p.iso_3166_2 || '');
    const place = {
      region: p.name || p.name_en || '',
      country: p.admin || '',
      cc: /^[A-Z]{2}-/.test(iso) ? iso.slice(0, 2) : /^[A-Z]{2}$/.test(p.iso_a2 || '') ? p.iso_a2 : '',
    };
    for (const [outer, ...holes] of polys) {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of outer) {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
      const item = { b, outer, holes, place };
      for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) {
        for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
          const k = `${x},${y}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(item);
        }
      }
    }
  }
  return ([x, y]) => {
    for (const it of grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) || []) {
      if (x < it.b[0] || x > it.b[2] || y < it.b[1] || y > it.b[3]) continue;
      if (pointInRing([x, y], it.outer) && !it.holes.some((h) => pointInRing([x, y], h))) return it.place;
    }
    return null;
  };
}
