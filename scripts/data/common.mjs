// Helpers shared by the trail-data readers in scripts/build-data.mjs.

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Douglas–Peucker in local metres. */
export function simplify(coords, tolMeters) {
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

/** Round to ~1 m and simplify: the stored form of every run and lift. */
export const packLine = (coords) => simplify(coords.map((c) => [r5(c[0]), r5(c[1])]), 1.5);

/** Centre of the bounding box of some coordinate lists, or null. */
export function bboxCenter(lists) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const list of lists) {
    for (const [x, y] of list) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX <= maxX ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

/** Trail convention from a country code, as OpenSkiMap assigns it. */
export function conventionFor(cc) {
  if (!cc) return 'north_america';
  if (cc === 'US' || cc === 'CA') return 'north_america';
  if (cc === 'JP') return 'japan';
  return 'europe';
}

export function readStream(file) {
  return fs.createReadStream(file, { highWaterMark: Number(process.env.BUILD_DATA_CHUNK) || 1 << 16 });
}

// Download servers sometimes answer 502/524 or drop a transfer, so each file
// is downloaded to disk in full, checked against Content-Length and retried
// with growing waits. 4xx errors (other than 408/429) fail at once.
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

export async function download(url, dest) {
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
