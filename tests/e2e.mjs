// End-to-end smoke test in headless Chromium with all network APIs mocked.
//
//   node tests/e2e.mjs [--shots <dir>]
//
// Serves the app locally, answers OpenSkiMap requests from the synthetic
// fixture, and serves terrain tiles from tests/.cache/tiles (downloaded on
// first use with curl). Requires the `playwright` package.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
  ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TILE_CACHE = path.join(ROOT, 'tests/.cache/tiles');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/synthetic-area.json'), 'utf8'));
const AREA_ID = fixture.area.id;

const areaFeature = {
  type: 'Feature',
  geometry: fixture.area.geometry,
  properties: {
    type: 'skiArea',
    id: AREA_ID,
    name: fixture.area.name,
    activities: ['downhill'],
    runConvention: 'north_america',
    statistics: null,
    places: [{ iso3166_1Alpha2: 'US', iso3166_2: 'US-VT', localized: { en: { country: 'United States', region: 'Vermont', locality: 'Testville' } } }],
  },
};
const skiAreas = [{ type: 'Feature', geometry: fixture.area.geometry, properties: { type: 'skiArea', id: AREA_ID, name: fixture.area.name } }];
const featureCollection = {
  type: 'FeatureCollection',
  features: [
    ...fixture.features.runs.map((r) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords },
      properties: { type: 'run', uses: ['downhill'], name: r.name, difficulty: r.difficulty, skiAreas },
    })),
    ...fixture.features.lifts.map((l) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: l.coords },
      properties: { type: 'lift', liftType: l.type, name: l.name, skiAreas },
    })),
  ],
};

function tile(z, x, y) {
  const file = path.join(TILE_CACHE, `${z}`, `${x}_${y}.png`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      execFileSync('curl', ['-sSf', '-m', '30', '-o', file, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`]);
    } catch {
      return null;
    }
  }
  return fs.readFileSync(file);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const CORS = { 'Access-Control-Allow-Origin': '*' };
await page.route('https://api.openskimap.org/**', (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/search') return route.fulfill({ json: [areaFeature], headers: CORS });
  if (url.pathname === '/features.geojson') return route.fulfill({ json: featureCollection, headers: CORS });
  return route.fulfill({ status: 404, body: '', headers: CORS });
});
await page.route('https://s3.amazonaws.com/elevation-tiles-prod/**', (route) => {
  const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  const body = m && tile(m[1], m[2], m[3]);
  return body ? route.fulfill({ body, contentType: 'image/png', headers: CORS }) : route.fulfill({ status: 404, body: '', headers: CORS });
});
await page.route(/overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru|nominatim\.openstreetmap\.org/, (route) => route.abort());

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

console.log(`serving ${base}`);
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
console.log('page loaded');

await step('search returns the fixture area', async () => {
  await page.fill('#search-input', 'Test Peak');
  await page.click('#search-form button[type=submit]');
  await page.waitForSelector('#search-results button', { timeout: 10000 });
  assert.match(await page.textContent('#search-results'), /Test Peak/);
});

await step('selecting an area renders a preview with stats', async () => {
  await page.click('#search-results button');
  await page.waitForSelector('#preview svg', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#preview svg path').length > 20);
  const facts = await page.textContent('#facts');
  assert.match(facts, /Summit/);
  assert.match(facts, /Trails\s*34/);
  assert.match(facts, /42\.\d{4}° N/);
});

for (const id of ['summit', 'topo', 'badge', 'ticket']) {
  await step(`template ${id} renders`, async () => {
    await page.click(`.tpl[data-id="${id}"]`);
    await page.waitForTimeout(400);
    const n = await page.$$eval('#preview svg path', (els) => els.length);
    assert.ok(n > 20, `only ${n} paths`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `app-${id}.png`) });
  });
}

await step('rotating and switching to ridgelines re-renders', async () => {
  await page.click('.tpl[data-id="summit"]');
  await page.selectOption('#terrain', 'ridges');
  await page.fill('#azimuth', '40');
  await page.dispatchEvent('#azimuth', 'input');
  await page.waitForTimeout(400);
  assert.ok((await page.$$eval('#preview svg #terrain-lines path, #preview svg #terrain path', (e) => e.length)) > 0);
});

await step('overrides and text edits flow into the design', async () => {
  await page.fill('#t-title', 'Mt. Test');
  await page.fill('[data-override="trails"]', '86');
  await page.waitForTimeout(300);
  const doc = await page.evaluate(() => window.__fallLine.current.overrides.trails);
  assert.equal(doc, '86');
});

await step('exported SVG is laser friendly', async () => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-svg')]);
  const file = await download.path();
  const svg = fs.readFileSync(file, 'utf8');
  assert.match(download.suggestedFilename(), /^mt-test-summit-102x102mm\.svg$/);
  assert.match(svg, /width="101.6mm" height="101.6mm" viewBox="0 0 101.6 101.6"/);
  assert.doesNotMatch(svg, /<text|<use|clipPath|<mask|stroke-dasharray|<style|<filter/);
  assert.match(svg, /<g id="trails"/);
  assert.match(svg, /<g id="text" fill="#000000"/);
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, 'export.svg'));
});

await step('PNG mockup downloads', async () => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-png')]);
  const buf = fs.readFileSync(await download.path());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});

await step('top-down map mode with contours', async () => {
  await page.click('#view-mode button[data-value="map"]');
  await page.waitForTimeout(500);
  assert.ok((await page.$$eval('#preview svg #terrain-lines path, #preview svg #terrain path', (e) => e.length)) > 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'app-map.png') });
});

await step('settings persist across reloads', async () => {
  await page.reload();
  await page.waitForSelector('#preview svg path', { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__fallLine.settings.view.mode), 'map');
});

await step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
