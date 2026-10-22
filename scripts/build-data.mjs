// Build the app's self-hosted trail data, so the browser never has to reach a
// third-party API at runtime:
//
//   data/index.json          compact search index of downhill ski areas
//   data/areas/<id>.json     runs + lifts of one ski area (simplified)
//
// Source: OpenSkiMap's published GeoJSON downloads (https://openskidata.org).
// If those can't be downloaded, OpenSnowMap's OpenStreetMap piste extract is
// used instead (--source auto, the default).
//
// Usage:
//   node scripts/build-data.mjs --out _site/data
//   node scripts/build-data.mjs --out data --source-dir ./downloads   (local OpenSkiMap files)
//   node scripts/build-data.mjs --out data --only "Mount Snow,Jackson Hole"
//   --source auto|openskimap|opensnowmap
//   --download-dir DIR   where downloads are kept (default: OS temp dir)
//   --source-base-url URL, --opensnowmap-url URL, --admin-url URL|none   (override sources)
//
// Data © OpenStreetMap contributors (ODbL).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { norm, download, conventionFor } from './data/common.mjs';
import * as openskimap from './data/openskimap.mjs';
import * as opensnowmap from './data/opensnowmap.mjs';
import * as places from './data/places.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), [])
);
const OUT = path.resolve(args.out || 'data');
const MODE = args.source || 'auto';
const OPENSKIMAP_URL = args['source-base-url'] || 'https://tiles.openskimap.org/geojson';
const OPENSNOWMAP_URL = args['opensnowmap-url'] || opensnowmap.DEFAULT_URL;
const ADMIN_URL = args['admin-url'] || places.DEFAULT_URL;
const SOURCE_DIR = args['source-dir'] ? path.resolve(args['source-dir']) : null;
const DOWNLOAD_DIR = path.resolve(args['download-dir'] || path.join(os.tmpdir(), 'trail-data-downloads'));
const ONLY = args.only ? String(args.only).split(',').map((s) => norm(s)).filter(Boolean) : null;

async function fromOpenSkiMap() {
  let files;
  if (SOURCE_DIR) {
    files = openskimap.FILES.map((n) => path.join(SOURCE_DIR, n));
  } else {
    files = [];
    for (const n of openskimap.FILES) files.push(await download(`${OPENSKIMAP_URL}/${n}`, path.join(DOWNLOAD_DIR, n)));
  }
  return { ...(await openskimap.readOpenSkiMap(files, { only: ONLY })), source: openskimap.SOURCE };
}

async function fromOpenSnowMap() {
  const file = await download(OPENSNOWMAP_URL, path.join(DOWNLOAD_DIR, 'planet_pistes.osm.gz'));
  const data = await opensnowmap.readOpenSnowMap(file, { only: ONLY });
  // Region and country names, which the extract doesn't have. Optional.
  if (ADMIN_URL !== 'none') {
    try {
      const lookup = places.adminLookup(await download(ADMIN_URL, path.join(DOWNLOAD_DIR, 'admin1.geojson')));
      let found = 0;
      for (const a of data.areas.values()) {
        const p = lookup([a.lon, a.lat]);
        if (!p) continue;
        Object.assign(a, { region: p.region, country: p.country, cc: p.cc });
        found++;
      }
      console.log(`places: ${found} of ${data.areas.size} ski areas`);
    } catch (err) {
      console.log(`Region names unavailable (${err.message}); continuing without them`);
    }
  }
  for (const a of data.areas.values()) a.conv = conventionFor(a.cc);
  return { ...data, source: opensnowmap.SOURCE };
}

function write({ areas, buckets, source }, t0) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'areas'), { recursive: true });
  const index = [];
  let bytes = 0;
  for (const [id, b] of buckets) {
    const runs = b.runs.length ? b.runs : b.areaRuns;
    if (!runs.length) continue;
    const a = areas.get(id);
    const body = `{"v":1,"id":${JSON.stringify(id)},"runs":[${runs.join(',')}],"lifts":[${b.lifts.join(',')}]}`;
    fs.writeFileSync(path.join(OUT, 'areas', `${id}.json`), body);
    bytes += body.length;
    // [id, name, lon, lat, locality, region, country, cc, convention, minE, maxE, runs, lifts, website]
    index.push([id, a.name, a.lon, a.lat, a.locality, a.region, a.country, a.cc, a.conv, a.minE, a.maxE, runs.length, b.lifts.length, a.web]);
  }
  index.sort((x, y) => y[11] - x[11]);
  const meta = {
    v: 1,
    built: new Date().toISOString(),
    sourceName: source.name,
    sourceUrl: source.url,
    attribution: source.attribution,
    fields: ['id', 'name', 'lon', 'lat', 'locality', 'region', 'country', 'cc', 'convention', 'minElevation', 'maxElevation', 'runs', 'lifts', 'website'],
    areas: index,
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(OUT, 'LICENSE.txt'),
    source.license +
      'OpenStreetMap data © OpenStreetMap contributors, available under the Open Database License (ODbL):\n' +
      'https://www.openstreetmap.org/copyright\n'
  );
  console.log(`wrote ${index.length} ski areas from ${source.name}, ${(bytes / 1e6).toFixed(1)} MB of trail data to ${OUT} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!index.length) throw new Error('No ski areas with downhill runs were produced');
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  let data;
  if (MODE === 'opensnowmap') {
    data = await fromOpenSnowMap();
  } else {
    try {
      data = await fromOpenSkiMap();
    } catch (err) {
      if (MODE !== 'auto' || SOURCE_DIR) throw err;
      console.log(`OpenSkiMap data unavailable (${err.message}); using OpenSnowMap's extract instead`);
      data = await fromOpenSnowMap();
    }
  }
  write(data, t0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
