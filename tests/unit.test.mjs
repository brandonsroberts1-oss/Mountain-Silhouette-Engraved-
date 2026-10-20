// Unit tests: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { simplify, chaikin, clipPolyline, dashPolyline, polylineLength, pathData, signedArea, resample, gaussianSmooth, strokeOutline, lineMask, knockout } from '../js/render/geometry.js';
import { isolines, niceInterval } from '../js/render/contours.js';
import { DemGrid } from '../js/render/dem-grid.js';
import { buildScene, DEFAULT_VIEW, uphillBearing, cleanVisibility } from '../js/render/scene.js';
import { buildModel, attachElevation, computeStats, groupTrails, joinRuns } from '../js/data/model.js';
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

test('joinRuns chains split OSM ways into continuous trails', () => {
  const runs = joinRuns([
    { name: 'A', difficulty: 'easy', pts: [[0, 0], [0, 100]] },
    { name: 'A', difficulty: 'expert', pts: [[0, 300], [0, 200]] },
    { name: 'A ', difficulty: 'easy', pts: [[0, 100], [0, 200]] },
    { name: 'B', difficulty: 'easy', pts: [[0, 100], [90, 100]] },
  ]);
  const a = runs.find((r) => r.name === 'A');
  assert.equal(runs.length, 2);
  assert.equal(a.difficulty, 'expert');
  assert.equal(polylineLength(a.pts), 300);
});

test('resample + gaussianSmooth remove jitter but keep endpoints', () => {
  const noisy = Array.from({ length: 101 }, (_, i) => [i * 5, i % 2 ? 3 : -3]);
  const smooth = gaussianSmooth(resample(noisy, 5), 4);
  assert.deepEqual(smooth[0], noisy[0]);
  assert.deepEqual(smooth[smooth.length - 1], noisy[noisy.length - 1]);
  const mid = smooth.slice(10, -10).map((p) => Math.abs(p[1]));
  assert.ok(Math.max(...mid) < 0.5, `residual wobble ${Math.max(...mid)}`);
});

test('cleanVisibility fills flicker gaps and drops specks', () => {
  const T = true;
  const F = false;
  assert.deepEqual(cleanVisibility([T, T, T, T, T, F, T, T, T, T, T], 3, 5), Array(11).fill(T));
  assert.deepEqual(cleanVisibility([F, F, F, F, T, T, F, F, F, F], 1, 5), Array(10).fill(F));
});

test('strokeOutline makes a closed shape of the requested width', () => {
  const o = strokeOutline([[0, 0], [10, 0]], [0.5, 0.5]);
  const ys = o.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) - 0.5) < 1e-9 && Math.abs(Math.min(...ys) + 0.5) < 1e-9);
  const xs = o.map((p) => p[0]);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 10, 'round caps extend past the ends');
});

test('knockout cuts lines where they pass near trails', () => {
  const mask = lineMask([[[0, 5], [20, 5]]], 1, 20, 20);
  const parts = knockout([[[10, 0], [10, 10]]], mask);
  assert.equal(parts.length, 2);
  assert.ok(parts[0][parts[0].length - 1][1] < 4.1 && parts[1][0][1] > 5.9);
});

// Bounding box of path data; arcs counted by endpoint ± radius.
function pathBox(d) {
  const toks = d.match(/[MLCQAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  };
  let i = 0;
  let cmd = '';
  const n = () => +toks[i++];
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) cmd = toks[i++];
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') add(n(), n());
    else if (cmd === 'Q') { add(n(), n()); add(n(), n()); }
    else if (cmd === 'C') { add(n(), n()); add(n(), n()); add(n(), n()); }
    else if (cmd === 'A') { const r = n(); n(); n(); n(); n(); const x = n(); const y = n(); add(x - r, y - r); add(x + r, y + r); }
    else i++;
  }
  return b;
}

test('lift ticket keeps every element on the ticket and clear of the notches', async () => {
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
  const tpl = TEMPLATES.find((t) => t.id === 'ticket');
  const sizes = [...tpl.sizes, { w: 101.6, h: 101.6 }, { w: 76.2, h: 127 }];
  for (const size of sizes) {
    for (const many of [false, true]) {
      const scene = buildScene(model, dem, { ...DEFAULT_VIEW, azimuth: 270 });
      const content = buildContent(stats, {
        texts: { title: many ? 'Whistler Blackcomb Resort' : 'Cone', subtitle: 'British Columbia · Canada', personal: many ? 'Our first run together · 2026' : '', header: 'Lift Ticket · 2026/27 Season', stub: 'Admit One' },
        stats: many ? { summit: true, base: true, vertical: true, trails: true, lifts: true, difficulty: true } : { summit: true, trails: true, difficulty: true },
        overrides: {}, units: 'ft', coordStyle: many ? 'dms' : 'decimal', coordSource: 'center', showCoords: true, showSerial: true, convention: 'north_america',
      });
      const doc = composeDesign({ template: tpl, W: size.w, H: size.h, scene, content, fonts, options: { titleScale: many ? 1.4 : 1, smallCaps: true, border: true, cornerRadius: 3 }, artOptions: {} });
      const { w: W, h: H } = size;
      // Same proportions as the template: notches are cut into the blank,
      // centred on its top and bottom edges at the perforation.
      const u = Math.min(H, W / 1.55);
      const border = u * 0.065; // outline inset + inner border offset
      const px = Math.min(W * 0.215, u * 0.36);
      const notchBorder = u * 0.075 + border; // the border's notch arc radius
      for (const it of doc.items) {
        if (it.layer === 'frame') continue;
        const [x0, y0, x1, y1] = pathBox(it.d);
        const where = `${W}x${H} ${many ? 'busy' : 'plain'} ${it.layer} [${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}]`;
        assert.ok(x0 >= border && y0 >= border && x1 <= W - border && y1 <= H - border, `outside the border: ${where}`);
        for (const [cx, cy] of [[px, 0], [px, H]]) {
          const nx = Math.max(x0, Math.min(cx, x1));
          const ny = Math.max(y0, Math.min(cy, y1));
          assert.ok(Math.hypot(nx - cx, ny - cy) >= notchBorder + u * 0.01, `crosses a notch: ${where}`);
        }
      }
    }
  }
});

test('bold trail style engraves trails as filled shapes', async () => {
  const model = coneModel();
  const dem = coneFor(model);
  attachElevation(model, dem);
  const scene = buildScene(model, dem, { ...DEFAULT_VIEW, azimuth: 270 });
  const { Doc, placeArt } = await import('../js/render/art.js');
  const bold = new Doc(100, 100);
  placeArt(bold, scene, { x: 5, y: 5, w: 90, h: 60 }, null, { trailStyle: 'bold' });
  assert.ok(bold.items.some((i) => i.layer === 'trails' && i.kind === 'fill'));
  const line = new Doc(100, 100);
  placeArt(line, scene, { x: 5, y: 5, w: 90, h: 60 }, null, { trailStyle: 'line' });
  assert.ok(line.items.some((i) => i.layer === 'trails' && i.kind === 'stroke'));
  assert.ok(!line.items.some((i) => i.layer === 'trails' && i.kind === 'fill'));
});
