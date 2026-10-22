// Geometric layout check, run in headless Chromium:
//
//   node tests/layout.mjs [--shots <dir>]
//
// Composes every template at every preset size (plus odd custom sizes) with
// plain and worst-case content, then samples points along every engraved path
// with the browser's SVG geometry engine and verifies that:
//   - everything lies on the physical blank (inside the cut outline)
//   - content stays inside the design's safe area (e.g. the ticket border)
//   - text, icons and art never touch a frame line (border, rings, rules)
//   - text and icons never overlap each other
// Sampling uses the engrave-ready export geometry (lines outlined to width).
// No network access is needed: the terrain is a synthetic mountain.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>layout</title>');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}layout-check`);

const runTemplate = (tplId) => page.evaluate(async ({ wantShots, tplId }) => {
  const { DemGrid } = await import('/js/render/dem-grid.js');
  const { buildScene, DEFAULT_VIEW } = await import('/js/render/scene.js');
  const { buildModel, attachElevation, computeStats } = await import('/js/data/model.js');
  const { composeDesign } = await import('/js/render/compose.js');
  const { TEMPLATES } = await import('/js/render/templates.js');
  const { buildSvg, engraveDoc } = await import('/js/render/svg.js');
  const { buildContent } = await import('/js/content.js');
  const { loadFont, browserLoader } = await import('/js/fonts.js');

  // Synthetic cone mountain with runs down its east face.
  const mk = (name, difficulty, a) => ({
    name,
    difficulty,
    coords: Array.from({ length: 30 }, (_, i) => {
      const r = 100 + i * 70;
      return [-72.9 + (r * Math.cos(a)) / 81500, 43 + (r * Math.sin(a)) / 110574];
    }),
  });
  const model = buildModel({
    runs: [mk('A', 'easy', -0.5), mk('B', 'intermediate', -0.2), mk('C', 'advanced', 0.1), mk('D', 'expert', 0.4)],
    lifts: [{ name: 'L', type: 'chair_lift', coords: [[-72.9 + 2000 / 81500, 43], [-72.9 + 150 / 81500, 43]] }],
  });
  const [sx, sy] = model.proj.toLocal([-72.9, 43]);
  const n = 121;
  const half = 4000;
  const cell = (2 * half) / (n - 1);
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      data[j * n + i] = 1000 + 900 * Math.max(0, 1 - Math.hypot(-half + i * cell - sx, -half + j * cell - sy) / 2500);
    }
  }
  const dem = new DemGrid({ nx: n, ny: n, x0: -half, y0: -half, cell, data });
  attachElevation(model, dem);
  const stats = computeStats({ center: model.center, statistics: null }, model, dem);

  const font = (id) => loadFont(id, browserLoader);
  const body = await font('montserrat');
  const bold = await font('montserrat-bold');
  const script = await font('great-vibes');

  const variants = [
    {
      id: 'plain',
      titleFont: 'cinzel',
      texts: { title: 'Mount Snow', subtitle: 'Vermont · USA', personal: '', header: 'Lift Ticket · 2026/27 Season', stub: 'Admit One' },
      stats: { summit: true, vertical: true, trails: true, difficulty: true },
      overrides: {},
      coordStyle: 'decimal',
      titleScale: 1,
    },
    {
      id: 'busy',
      titleFont: 'playfair',
      texts: { title: 'Snow Valley Mountain Resort', subtitle: 'British Columbia · Canada', personal: 'Our first run together · 2026', header: 'Lift Ticket · 2026/27 Season', stub: 'Admit One' },
      stats: { summit: true, base: true, vertical: true, trails: true, lifts: true, difficulty: true },
      overrides: { difficulty: 'expert', summit: '12,840', trails: '1,234' },
      coordStyle: 'dms',
      titleScale: 1.4,
    },
    {
      id: 'script',
      titleFont: 'great-vibes',
      texts: { title: 'Jackson Hole', subtitle: 'Wyoming · USA', personal: 'Est. 1965', header: 'Lift Ticket', stub: 'Admit One' },
      stats: { summit: true, trails: true, difficulty: true },
      overrides: { difficulty: 'expert' },
      coordStyle: 'decimal',
      titleScale: 1.2,
    },
  ];

  const NS = 'http://www.w3.org/2000/svg';
  const host = document.createElement('div');
  document.body.append(host);
  const violations = [];
  const shots = [];
  let designs = 0;

  for (const tpl of TEMPLATES.filter((t) => t.id === tplId)) {
    const customs = tpl.shape === 'circle' ? [{ id: 'c2', w: 60, h: 60 }] : tpl.shape === 'ticket' ? [{ id: 'csq', w: 101.6, h: 101.6 }, { id: 'cpt', w: 76.2, h: 127 }] : [{ id: 'cwide', w: 177.8, h: 101.6 }, { id: 'csm', w: 63.5, h: 63.5 }];
    const views = [{ ...DEFAULT_VIEW, ...tpl.defaults, azimuth: 270 }];
    for (const size of [...tpl.sizes, ...customs]) {
      for (const v of variants) {
        for (const border of v.id === 'plain' ? [true, false] : [true]) {
          const scene = buildScene(model, dem, views[0]);
          const content = buildContent(stats, {
            texts: v.texts, stats: v.stats, overrides: v.overrides, units: 'ft', coordStyle: v.coordStyle,
            coordSource: 'center', showCoords: true, showSerial: true, convention: 'north_america',
          });
          if (views[0].mode === 'map') content.northAngle = 30;
          const fonts = { title: await font(v.titleFont), body, bold, script };
          const doc = composeDesign({
            template: tpl, W: size.w, H: size.h, scene, content, fonts,
            options: { titleScale: v.titleScale, smallCaps: true, border, dividers: true, cornerRadius: 3 },
            artOptions: { highlight: 'B' },
          });
          designs++;
          const where = `${tpl.id} ${size.id} ${size.w}x${size.h} ${v.id}${border ? '' : ' no-border'}`;
          host.innerHTML = buildSvg(doc, { mode: 'export', includeCut: true });
          // Check what will actually be engraved: lines outlined to their width.
          const engraved = engraveDoc(doc);
          const svg = host.querySelector('svg');
          const mkPath = (d, sw) => {
            const p = document.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', 'none');
            p.setAttribute('stroke-width', String(sw));
            svg.append(p);
            return p;
          };
          const cut = mkPath(doc.cut, 0);
          const safe = doc.safe ? mkPath(doc.safe, 0) : null;
          // Frame lines widened by the clearance we require around them (0.25 mm each side).
          const frames = doc.items.filter((i) => i.layer === 'frame').map((i) => {
            const p = mkPath(i.d, (i.width || 0) + 0.5);
            p.setAttribute('stroke', '#000');
            return p;
          });
          const seen = new Set();
          const report = (kind, layer, pt) => {
            const key = `${kind}|${layer}`;
            if (seen.has(key)) return;
            seen.add(key);
            violations.push(`${where}: ${layer} ${kind} near (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`);
          };
          // Sample each subpath separately: getPointAtLength walks the path from
          // its start, so long multi-glyph paths would be quadratic.
          const probe = mkPath('M0 0', 0);
          for (const it of engraved) {
            for (const sub of it.d.split(/(?=M)/)) {
              probe.setAttribute('d', sub);
              const len = probe.getTotalLength();
              const steps = Math.min(400, Math.max(2, Math.ceil(len / 0.35)));
              for (let s = 0; s <= steps; s++) {
                const pt = probe.getPointAtLength((len * s) / steps);
                if (!cut.isPointInFill(pt)) report('is off the blank', it.layer, pt);
                if (it.layer === 'frame') continue;
                if (safe && !safe.isPointInFill(pt)) report('crosses the border / safe area', it.layer, pt);
                if (!it.meta?.touchesFrame && frames.some((f) => f.isPointInStroke(pt))) report('touches a frame line', it.layer, pt);
              }
            }
          }
          // Text and icons must not overlap or crowd each other (< 0.2 mm apart).
          const marks = engraved
            .filter((it) => it.layer === 'text' && !it.meta?.touchesFrame)
            .map((it) => {
              const p = mkPath(it.d, 0.4);
              p.setAttribute('stroke', '#000');
              p.setAttribute('fill', '#000');
              const b = p.getBBox();
              return { it, p, b };
            });
          const near = (a, b) => a.x - 0.3 < b.x + b.width && b.x - 0.3 < a.x + a.width && a.y - 0.3 < b.y + b.height && b.y - 0.3 < a.y + a.height;
          for (let i = 0; i < marks.length; i++) {
            for (let j = 0; j < marks.length; j++) {
              if (i === j || !near(marks[i].b, marks[j].b)) continue;
              const A = marks[i];
              const B = marks[j];
              let hit = null;
              for (const sub of A.it.d.split(/(?=M)/)) {
                probe.setAttribute('d', sub);
                const len = probe.getTotalLength();
                const steps = Math.min(200, Math.max(2, Math.ceil(len / 0.3)));
                for (let s = 0; s <= steps && !hit; s++) {
                  const pt = probe.getPointAtLength((len * s) / steps);
                  if (B.p.isPointInFill(pt) || B.p.isPointInStroke(pt)) hit = pt;
                }
                if (hit) break;
              }
              if (hit) {
                const key = `overlap|${Math.min(i, j)}|${Math.max(i, j)}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  violations.push(`${where}: text/icons overlap or nearly touch near (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)})`);
                }
              }
            }
          }
          if (wantShots && v.id !== 'plain' && border) {
            shots.push({ name: `${tpl.id}-${size.id}-${v.id}`, svg: buildSvg(doc, { mode: 'preview', material: 'slate', blank: doc.cut }) });
          }
        }
      }
    }
  }
  return { violations, designs, shots };
}, { wantShots: !!SHOTS, tplId });

const result = { violations: [], designs: 0, shots: [] };
for (const id of ['summit', 'topo', 'badge', 'ticket']) {
  const t0 = Date.now();
  const r = await runTemplate(id);
  console.log(`${id}: ${r.designs} designs, ${r.violations.length} problems (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  result.violations.push(...r.violations);
  result.designs += r.designs;
  result.shots.push(...r.shots);
}

if (SHOTS) {
  for (const s of result.shots) {
    await page.setContent(`<body style="margin:0;background:#777">${s.svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="900"')}</body>`);
    await (await page.$('svg')).screenshot({ path: path.join(SHOTS, `${s.name}.png`) });
  }
}

await browser.close();
server.close();
console.log(`checked ${result.designs} designs`);
if (result.violations.length) {
  console.log(`${result.violations.length} layout problems:`);
  for (const v of result.violations) console.log(`  ${v}`);
  process.exit(1);
}
console.log('no layout problems');
