// Unit tests: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { simplify, chaikin, clipPolyline, dashPolyline, polylineLength, pathData, signedArea } from '../js/render/geometry.js';
import { isolines, niceInterval } from '../js/render/contours.js';
import { DemGrid } from '../js/render/dem-grid.js';
import { buildScene, DEFAULT_VIEW, uphillBearing } from '../js/render/scene.js';
import { buildModel, attachElevation, computeStats, groupTrails } from '../js/data/model.js';
import { formatCoords, elevationParts, difficultyInfo, difficultyClass, slugify, placeLabel } from '../js/format.js';
import { buildContent, currentSeason } from '../js/content.js';
import { loadFont } from '../js/fonts.js';
import { textPath, arcTextPath, fitSize, layoutText } from '../js/render/text.js';
import { composeDesign } from '../js/render/compose.js';
import { TEMPLATES } from '../js/render/templates.js';
import { buildSvg } from '../js/render/svg.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fontLoader = (p) => Promise.resolve(fs.readFileSync(path.join(ROOT, 'fonts', p))).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

// A synthetic cone-shaped mountain: summit at (sx, sy), 900 m relief.
function coneDem([sx, sy] = [0, 0], n = 121, half = 3000) {
  const cell = (2 * half) / (n - 1);
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * cell;
      const y = -half + j * cell;
      data[j * n + i] = 1000 + 900 * Math.max(0, 1 - Math.hypot(x - sx, y - sy) / 2500);
    }
  }
  return new DemGrid({ nx: n, ny: n, x0: -half, y0: -half, cell, data });
}

test('simplify keeps endpoints and drops collinear points', () => {
  const line = [[0, 0], [1, 0.001], [2, 0], [3, 0]];
  assert.deepEqual(simplify(line, 0.01), [[0, 0], [3, 0]]);
});

test('chaikin preserves endpoints', () => {
  const out = chaikin([[0, 0], [10, 0], [10, 10]], 2);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [10, 10]);
  assert.ok(out.length > 3);
});

test('clipPolyline clips to rect and subtracts holes', () => {
  const rect = { type: 'rect', x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(clipPolyline([[-5, 5], [15, 5]], { shape: rect }), [[[0, 5], [10, 5]]]);
  const parts = clipPolyline([[-5, 5], [15, 5]], { shape: rect, holes: [{ type: 'rect', x: 4, y: 0, w: 2, h: 10 }] });
  assert.deepEqual(parts, [[[0, 5], [4, 5]], [[6, 5], [10, 5]]]);
  const circ = clipPolyline([[-10, 0], [10, 0]], { shape: { type: 'circle', cx: 0, cy: 0, r: 5 } });
  assert.equal(circ.length, 1);
  assert.ok(Math.abs(circ[0][0][0] + 5) < 1e-9 && Math.abs(circ[0][1][0] - 5) < 1e-9);
});

test('clipPolyline keeps continuous inside runs as one polyline', () => {
  const parts = clipPolyline([[1, 1], [2, 2], [3, 1], [4, 2]], { shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 } });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].length, 4);
});

test('dashPolyline produces real dash segments', () => {
  const dashes = dashPolyline([[0, 0], [10, 0]], 1, 1);
  assert.equal(dashes.length, 5);
  for (const d of dashes) assert.ok(Math.abs(polylineLength(d) - 1) < 1e-9);
});

test('pathData formats compactly', () => {
  assert.equal(pathData([[[0, 0], [1.23456, -0.00001]]]), 'M0 0L1.235 0');
});

test('signedArea is positive for clockwise (screen) polygons', () => {
  assert.ok(signedArea([[0, 0], [1, 0], [1, 1], [0, 1]]) > 0);
});

test('isolines of a cone are closed rings at the right radius', () => {
  const dem = coneDem();
  const lines = isolines(dem.data, dem.nx, dem.ny, 1450);
  assert.equal(lines.length, 1);
  const ring = lines[0];
  const first = ring[0];
  const last = ring[ring.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9, 'ring is closed');
  const r = Math.hypot(dem.x0 + ring[5][0] * dem.cell, dem.y0 + ring[5][1] * dem.cell);
  assert.ok(Math.abs(r - 1250) < 60, `radius ${r}`);
});

test('niceInterval picks round numbers', () => {
  assert.equal(niceInterval(700, 15), 50);
  assert.equal(niceInterval(120, 12), 10);
});

test('format helpers', () => {
  assert.deepEqual(elevationParts(1097.28, 'ft'), { value: '3,600', unit: 'FT' });
  assert.deepEqual(elevationParts(1097.28, 'm'), { value: '1,097', unit: 'M' });
  assert.deepEqual(formatCoords(42.96021, -72.92043), { lat: '42.9602° N', lon: '72.9204° W' });
  assert.deepEqual(formatCoords(42.5, -72.25, 'dms'), { lat: '42°30′00″ N', lon: '72°15′00″ W' });
  assert.equal(difficultyInfo('expert').symbol, 'double');
  assert.equal(difficultyInfo('intermediate', 'europe').short, 'Red');
  assert.equal(difficultyClass('freeride'), 'expert');
  assert.equal(slugify('Mürren – Schilthorn!'), 'murren-schilthorn');
  assert.equal(placeLabel({ region: 'Vermont', country: 'United States', countryCode: 'US' }), 'Vermont · USA');
  assert.equal(currentSeason(new Date(2026, 9, 19)), '2026/27');
  assert.equal(currentSeason(new Date(2027, 1, 1)), '2026/27');
});

test('groupTrails merges named segments and drops short unnamed connectors', () => {
  const runs = [
    { name: 'Ego Alley', difficulty: 'advanced', pts: [[0, 0], [0, 300]] },
    { name: 'ego alley ', difficulty: 'expert', pts: [[0, 300], [0, 600]] },
    { name: null, difficulty: 'easy', pts: [[0, 0], [0, 100]] },
    { name: null, difficulty: 'easy', pts: [[0, 0], [0, 400]] },
  ];
  const trails = groupTrails(runs);
  assert.equal(trails.length, 2);
  assert.equal(trails[0].difficulty, 'expert');
});

function coneModel() {
  // Runs descending the east face of the cone; lift up the middle.
  const mk = (name, difficulty, a) => ({
    name,
    difficulty,
    coords: Array.from({ length: 30 }, (_, i) => {
      const r = 100 + i * 70;
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      return [-72.9 + x / 81500, 43 + y / 110574];
    }),
  });
  const features = {
    runs: [mk('A', 'easy', -0.4), mk('B', 'intermediate', 0), mk('C', 'expert', 0.4)],
    lifts: [{ name: 'L', type: 'chair_lift', coords: [[-72.9 + 2000 / 81500, 43], [-72.9 + 150 / 81500, 43]] }],
  };
  const model = buildModel(features);
  model.summitLocal = model.proj.toLocal([-72.9, 43]);
  return model;
}

function coneFor(model) {
  return coneDem(model.summitLocal);
}

test('model + stats on a synthetic mountain', () => {
  const model = coneModel();
  const dem = coneFor(model);
  attachElevation(model, dem);
  const stats = computeStats({ center: model.center, statistics: null }, model, dem);
  assert.equal(stats.trailCount, 3);
  assert.equal(stats.maxDifficulty, 'expert');
  assert.ok(stats.summit > stats.base);
  assert.equal(stats.liftCount, 1);
});

test('uphill bearing faces the summit from the base', () => {
  const model = coneModel();
  const dem = coneFor(model);
  // Runs go east (downhill), so looking uphill means looking roughly west.
  const az = uphillBearing(model, dem);
  assert.ok(az > 240 && az < 300, `bearing ${az}`);
});

test('3D scene hides trails behind the mountain', () => {
  const model = coneModel();
  const dem = coneFor(model);
  attachElevation(model, dem);
  const front = buildScene(model, dem, { ...DEFAULT_VIEW, azimuth: 270, terrain: 'ridges' });
  const back = buildScene(model, dem, { ...DEFAULT_VIEW, azimuth: 90, terrain: 'outline' });
  const len = (s) => s.trails.reduce((a, t) => a + t.lines.reduce((b, l) => b + l.length, 0), 0);
  assert.ok(len(front) > len(back) * 1.5, `front ${len(front)} vs back ${len(back)}`);
  assert.ok(front.terrain.length > 10);
  assert.ok(back.terrain.length >= 1);
});

test('map scene draws contours', () => {
  const model = coneModel();
  const dem = coneFor(model);
  attachElevation(model, dem);
  const scene = buildScene(model, dem, { ...DEFAULT_VIEW, mode: 'map', terrain: 'contours' });
  assert.ok(scene.terrain.length > 5);
  assert.equal(scene.trails.length, 3);
});

test('text renders to outline paths, fits and bends', async () => {
  const font = await loadFont('cinzel', fontLoader);
  const t = textPath(font, 'Mount Snow', { x: 50, y: 50, size: 10 });
  assert.ok(t.d.startsWith('M') && t.width > 20);
  assert.ok(fitSize(font, 'A very long resort name indeed', 40, 12) < 12);
  const arc = arcTextPath(font, 'Zürich', { cx: 50, cy: 50, r: 40, size: 6, side: 'top' });
  assert.ok(arc.d.length > 100);
  // Fallback glyphs: prime → apostrophe when missing.
  assert.ok(layoutText(font, '42°57′', { size: 10 }).placed.length === 6);
});

test('every template composes into a laser-safe SVG', async () => {
  const model = coneModel();
  const dem = coneFor(model);
  attachElevation(model, dem);
  const stats = computeStats({ center: model.center, statistics: null }, model, dem);
  const fonts = {
    title: await loadFont('cinzel', fontLoader),
    body: await loadFont('montserrat', fontLoader),
    bold: await loadFont('montserrat-bold', fontLoader),
    script: await loadFont('great-vibes', fontLoader),
  };
  for (const tpl of TEMPLATES) {
    const size = tpl.sizes[0];
    const scene = buildScene(model, dem, { ...DEFAULT_VIEW, ...tpl.defaults, azimuth: 270 });
    const content = buildContent(stats, {
      texts: { title: 'Cone Mountain', subtitle: 'Vermont · USA', personal: 'Est. 1954', header: 'Lift Ticket', stub: 'Admit One' },
      stats: { summit: true, vertical: true, trails: true, difficulty: true },
      overrides: { trails: '86' },
      units: 'ft',
      coordStyle: 'decimal',
      coordSource: 'center',
      showCoords: true,
      showSerial: true,
      convention: 'north_america',
    });
    assert.equal(content.stats.find((s) => s.id === 'trails').value, '86');
    const doc = composeDesign({ template: tpl, W: size.w, H: size.h, scene, content, fonts, options: { titleScale: 1, smallCaps: true, border: true, dividers: true, cornerRadius: 3 }, artOptions: { highlight: 'B' } });
    const svg = buildSvg(doc, { mode: 'export', colorMode: 'layers', lineWeight: 0.2, includeCut: true });
    assert.match(svg, new RegExp(`width="${size.w}mm" height="${size.h}mm"`), tpl.id);
    assert.doesNotMatch(svg, /<text|<use|clipPath|<mask|dasharray|<style|NaN|undefined|Infinity/, tpl.id);
    assert.match(svg, /<g id="trails"/, tpl.id);
    assert.match(svg, /<g id="highlight"/, tpl.id);
    assert.match(svg, /<g id="cut"/, tpl.id);
    // Everything must sit on the blank.
    const nums = [...svg.matchAll(/d="([^"]+)"/g)].flatMap((m) => (m[1].match(/-?\d+(\.\d+)?/g) || []).map(Number));
    assert.ok(Math.min(...nums) > -1 && Math.max(...nums) < Math.max(size.w, size.h) + 1, tpl.id);
  }
});
