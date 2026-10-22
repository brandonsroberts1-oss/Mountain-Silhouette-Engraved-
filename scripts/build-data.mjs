// Build the app's self-hosted trail data from OpenSkiMap's published GeoJSON
// downloads (https://openskidata.org), so the browser never has to reach a
// third-party API at runtime:
//
//   data/index.json          compact search index of downhill ski areas
//   data/areas/<id>.json     runs + lifts of one ski area (simplified)
//
// Usage:
//   node scripts/build-data.mjs --out _site/data
//   node scripts/build-data.mjs --out data --source-dir ./downloads   (local files)
//   node scripts/build-data.mjs --out data --only "Mount Snow,Jackson Hole"
//   --download-dir DIR   where downloads are kept (default: OS temp dir)
//
// Data © OpenStreetMap contributors (ODbL), processed by OpenSkiMap.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), [])
);
const OUT = path.resolve(args.out || 'data');
const SOURCE = args['source-base-url'] || 'https://tiles.openskimap.org/geojson';
const SOURCE_DIR = args['source-dir'] ? path.resolve(args['source-dir']) : null;
const DOWNLOAD_DIR = path.resolve(args['download-dir'] || path.join(os.tmpdir(), 'openskimap-downloads'));
const ONLY = args.only ? String(args.only).split(',').map((s) => norm(s)).filter(Boolean) : null;
const SKIP_LIFTS = new Set(['magic_carpet', 'zip_line', 'funicular', 'railway', 'rack_railway', 'canopy', 'platter_station']);

function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Streaming FeatureCollection reader: yields each object found directly inside
// the top-level "features" array, without loading the whole file (runs.geojson
// is about 1 GB).

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

// The download server sits behind Cloudflare and now and then answers 524
// (origin timeout) or drops a transfer, so each file is downloaded to disk in
// full, checked against Content-Length and retried with growing waits.
const RETRY_WAITS = (process.env.BUILD_DATA_RETRY_WAITS || '30,120,300').split(',').map(Number);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function downloadOnce(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fall-line-studio data build (github.com)', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(30 * 60e3),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const err = new Error(`${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`);
    err.retry = res.status >= 500 || res.status === 408 || res.status === 429;
    throw err;
  }
  const expected = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${dest}.part`));
  const size = fs.statSync(`${dest}.part`).size;
  if (expected && size !== expected) throw new Error(`download of ${url} stopped at ${size} of ${expected} bytes`);
  fs.renameSync(`${dest}.part`, dest);
  return size;
}

async function download(name) {
  const url = `${SOURCE}/${name}`;
  const dest = path.join(DOWNLOAD_DIR, name);
  for (let attempt = 1; ; attempt++) {
    const t = Date.now();
    console.log(`Downloading ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    try {
      const size = await downloadOnce(url, dest);
      console.log(`  ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      return dest;
    } catch (err) {
      const wait = RETRY_WAITS[attempt - 1];
      if (err.retry === false || wait == null) throw err;
      console.log(`  failed after ${((Date.now() - t) / 1000).toFixed(0)} s: ${err.message}; retrying in ${wait} s`);
      await sleep(wait);
    }
  }
}

function open(file) {
  return fs.createReadStream(file, { highWaterMark: Number(process.env.BUILD_DATA_CHUNK) || 1 << 16 });
}

/** Local paths of the three source files, downloading them unless --source-dir is given. */
async function sources() {
  const names = ['ski_areas.geojson', 'runs.geojson', 'lifts.geojson'];
  if (SOURCE_DIR) return names.map((n) => path.join(SOURCE_DIR, n));
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const files = [];
  for (const n of names) files.push(await download(n));
  return files;
}

// ---------------------------------------------------------------------------
// Geometry: simplify (Douglas–Peucker in local metres) and round to ~1 m.

function simplify(coords, tolMeters) {
  if (coords.length < 3) return coords;
  const lat0 = (coords[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110574;
  const pts = coords.map(([lon, lat]) => [lon * kx, lat * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolMeters * tolMeters;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s];
    const dx = pts[e][0] - ax;
    const dy = pts[e][1] - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d2 = (pts[i][0] - ax - t * dx) ** 2 + (pts[i][1] - ay - t * dy) ** 2;
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

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

function center(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  const all = rings(geometry).flat();
  if (!all.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of all) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

const packLine = (coords) => simplify(coords.map((c) => [r5(c[0]), r5(c[1])]), 1.5);
const areaIds = (p) => (p.skiAreas || []).map((sa) => (typeof sa === 'string' ? sa : sa && sa.properties && sa.properties.id)).filter(Boolean);

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const [skiAreasFile, runsFile, liftsFile] = await sources();
  const areas = new Map(); // id -> index entry
  const buckets = new Map(); // id -> { runs: [json strings], areaRuns: [], lifts: [] }

  for await (const f of features(open(skiAreasFile))) {
    const p = f.properties || {};
    if (!p.id || !p.name) continue;
    if (p.activities && !p.activities.includes('downhill')) continue;
    if (ONLY && !ONLY.some((q) => norm(p.name).includes(q))) continue;
    const c = center(f.geometry);
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

  const bucket = (id) => {
    if (!buckets.has(id)) buckets.set(id, { runs: [], areaRuns: [], lifts: [] });
    return buckets.get(id);
  };

  let nRuns = 0;
  for await (const f of features(open(runsFile))) {
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
  for await (const f of features(open(liftsFile))) {
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
    source: SOURCE_DIR ? 'local files' : SOURCE,
    attribution: 'Data © OpenStreetMap contributors (ODbL) and Skimap.org, processed by OpenSkiMap (openskidata.org)',
    fields: ['id', 'name', 'lon', 'lat', 'locality', 'region', 'country', 'cc', 'convention', 'minElevation', 'maxElevation', 'runs', 'lifts', 'website'],
    areas: index,
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(OUT, 'LICENSE.txt'),
    'This directory contains data derived from OpenSkiMap (https://openskimap.org, https://openskidata.org),\n' +
      'which combines OpenStreetMap and Skimap.org data.\n\n' +
      'OpenStreetMap data © OpenStreetMap contributors, available under the Open Database License (ODbL):\n' +
      'https://www.openstreetmap.org/copyright\n'
  );
  console.log(`wrote ${index.length} ski areas, ${(bytes / 1e6).toFixed(1)} MB of trail data to ${OUT} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!index.length) throw new Error('No ski areas with downhill runs were produced');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
