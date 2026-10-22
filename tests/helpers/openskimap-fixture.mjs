// Test helper: write small ski_areas / runs / lifts GeoJSON files in the shape
// of OpenSkiMap's published downloads, built from the synthetic fixture.

import fs from 'node:fs';
import path from 'node:path';

const summary = (id, name) => ({ type: 'Feature', geometry: null, properties: { type: 'skiArea', id, name } });

export function writeOpenSkiMapFixture(dir, fixture) {
  fs.mkdirSync(dir, { recursive: true });
  const id = fixture.area.id;
  const [lon, lat] = fixture.area.center;
  const skiAreas = [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[lon - 0.03, lat - 0.03], [lon + 0.03, lat - 0.03], [lon + 0.03, lat + 0.03], [lon - 0.03, lat + 0.03], [lon - 0.03, lat - 0.03]]] },
      properties: {
        type: 'skiArea', id, name: fixture.area.name, activities: ['downhill'], runConvention: 'north_america',
        statistics: { minElevation: 600, maxElevation: 1094 }, websites: ['https://example.com'],
        places: [{ iso3166_1Alpha2: 'US', iso3166_2: 'US-VT', localized: { en: { country: 'United States', region: 'Vermont', locality: 'Testville' } } }],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10.16, 47.17] },
      properties: { type: 'skiArea', id: 'zurs', name: 'Zürs am Arlberg', activities: ['downhill'], runConvention: 'europe', statistics: {}, places: [{ iso3166_1Alpha2: 'AT', localized: { en: { country: 'Austria', region: 'Vorarlberg', locality: 'Lech' } } }] },
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 47] }, properties: { type: 'skiArea', id: 'nordic', name: 'Langlauf Loipe', activities: ['nordic'] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [11, 47] }, properties: { type: 'skiArea', id: 'unnamed', name: null, activities: ['downhill'] } },
  ];
  const ele = (coords) => coords.map(([x, y], i) => [x, y, 1000 - i * 5]);
  const runs = [
    ...fixture.features.runs.map((r) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: ele(r.coords) },
      properties: { type: 'run', uses: ['downhill'], name: r.name, difficulty: r.difficulty, skiAreas: [summary(id, fixture.area.name)], places: [], elevationProfile: null },
    })),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[10.16, 47.17], [10.17, 47.16], [10.18, 47.15]] }, properties: { type: 'run', uses: ['downhill'], name: 'Madloch', difficulty: 'expert', skiAreas: [summary('zurs', 'Zürs am Arlberg')] } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[10.16, 47.17], [10.161, 47.17], [10.161, 47.171], [10.16, 47.17]]] }, properties: { type: 'run', uses: ['downhill'], name: 'Bowl area', difficulty: 'advanced', skiAreas: [summary('zurs', 'Zürs am Arlberg')] } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 47], [10.01, 47.01]] }, properties: { type: 'run', uses: ['nordic'], name: 'Loipe', skiAreas: [summary('nordic', 'Langlauf Loipe')] } },
  ];
  const lifts = [
    ...fixture.features.lifts.map((l) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: l.coords },
      properties: { type: 'lift', liftType: 'chair_lift', status: 'operating', name: l.name, skiAreas: [summary(id, fixture.area.name)] },
    })),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: fixture.features.lifts[0].coords }, properties: { type: 'lift', liftType: 'magic_carpet', status: 'operating', name: 'Carpet', skiAreas: [summary(id, fixture.area.name)] } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: fixture.features.lifts[0].coords }, properties: { type: 'lift', liftType: 'chair_lift', status: 'abandoned', name: 'Old chair', skiAreas: [summary(id, fixture.area.name)] } },
  ];
  // One feature per line, like OpenSkiMap's files, plus a top-level crs object.
  const write = (name, feats) =>
    fs.writeFileSync(
      path.join(dir, name),
      `{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:OGC:1.3:CRS84"}},"features":[\n${feats.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`
    );
  write('ski_areas.geojson', skiAreas);
  write('runs.geojson', runs);
  write('lifts.geojson', lifts);
}
