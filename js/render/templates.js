// Layout templates. Each draws text, icons, frames and the trail art onto a Doc
// in millimetres.
//
// c (content): { title, subtitle, personal, header, stub, coords, serial,
//               stats: [{ id, icon(cx, cy, s), value, unit, label, inline }],
//               maxDifficulty: { symbol, label, short }, northAngle }
// f (fonts):   { title, body, bold, script } FontSets
// o (options): { titleScale, smallCaps, border, cornerRadius, dividers }
// art(doc, box, region): draws the trail art.

import { textPath, arcTextPath, fitSize, layoutText } from './text.js';
import { rectPath, circlePath, pathData, fmt } from './geometry.js';
import * as icons from './icons.js';

export const TEMPLATES = [
  {
    id: 'summit',
    name: 'Summit',
    blurb: 'Mountain art over a bold name and an icon stats row.',
    shape: 'rect',
    sizes: [
      { id: 'sq4', label: 'Square coaster 4″', w: 101.6, h: 101.6 },
      { id: 'sq375', label: 'Square coaster 3.75″', w: 95.25, h: 95.25 },
      { id: 'sq35', label: 'Square coaster 3.5″', w: 88.9, h: 88.9 },
      { id: 'p57', label: 'Plaque 5×7″ portrait', w: 127, h: 177.8 },
      { id: 'p810', label: 'Plaque 8×10″ portrait', w: 203.2, h: 254 },
    ],
    defaults: { mode: '3d', terrain: 'outline' },
  },
  {
    id: 'topo',
    name: 'Topo',
    blurb: 'Top-down trail map on contours with a map-style border and title block.',
    shape: 'rect',
    sizes: [
      { id: 'sq4', label: 'Square coaster 4″', w: 101.6, h: 101.6 },
      { id: 'sq375', label: 'Square coaster 3.75″', w: 95.25, h: 95.25 },
      { id: 'p57', label: 'Plaque 5×7″ portrait', w: 127, h: 177.8 },
      { id: 'l75', label: 'Plaque 7×5″ landscape', w: 177.8, h: 127 },
      { id: 'p810', label: 'Plaque 8×10″ portrait', w: 203.2, h: 254 },
    ],
    defaults: { mode: 'map', terrain: 'contours' },
  },
  {
    id: 'badge',
    name: 'Badge',
    blurb: 'Round patch-style seal with the name on an arc, for round coasters and ornaments.',
    shape: 'circle',
    sizes: [
      { id: 'r4', label: 'Round coaster 4″', w: 101.6, h: 101.6 },
      { id: 'r375', label: 'Round coaster 3.75″', w: 95.25, h: 95.25 },
      { id: 'r35', label: 'Round 3.5″', w: 88.9, h: 88.9 },
      { id: 'r3', label: 'Ornament 3″', w: 76.2, h: 76.2 },
    ],
    defaults: { mode: '3d', terrain: 'ridges' },
  },
  {
    id: 'ticket',
    name: 'Lift Ticket',
    blurb: 'Vintage lift ticket with a tear-off stub, dotted stat leaders and a serial number.',
    shape: 'ticket',
    sizes: [
      { id: 't53', label: 'Ticket 5×3″', w: 127, h: 76.2 },
      { id: 't425', label: 'Ticket 4×2.5″', w: 101.6, h: 63.5 },
      { id: 't74', label: 'Ticket 7×4″', w: 177.8, h: 101.6 },
    ],
    defaults: { mode: '3d', terrain: 'ridges' },
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
}

// --------------------------------------------------------------------------
// Helpers

function T(doc, fontSet, str, opts) {
  if (!str) return null;
  const r = textPath(fontSet, str, opts);
  doc.fill('text', r.d);
  return r;
}

/** Big value with a small unit after it, centred on cx. */
function valueWithUnit(doc, f, st, cx, y, size, maxW) {
  const unitSize = size * 0.52;
  const gap = st.unit ? size * 0.18 : 0;
  let vw = layoutText(f.bold, st.value, { size }).width;
  let uw = st.unit ? layoutText(f.body, st.unit, { size: unitSize, tracking: 0.08 }).width : 0;
  let k = 1;
  if (maxW && vw + gap + uw > maxW) k = maxW / (vw + gap + uw);
  const x0 = cx - ((vw + gap + uw) * k) / 2;
  T(doc, f.bold, st.value, { x: x0, y, size: size * k, align: 'left' });
  if (st.unit) T(doc, f.body, st.unit, { x: x0 + (vw + gap) * k, y, size: unitSize * k, align: 'left', tracking: 0.08 });
}

/**
 * Inline row of text + icons, centred at cx on a baseline. items:
 * { text, font } | { icon: (cx, cy, s) => d, w } | { sep: true }.
 */
function inlineRow(doc, items, cx, y, size, maxW, tracking = 0.12) {
  const gap = size * 0.45;
  const iconS = size * 1.05;
  const measureAll = (sz) =>
    items.map((it) => {
      if (it.text) return layoutText(it.font, it.text, { size: sz, tracking, caps: true }).width;
      if (it.sep) return sz * 0.25;
      return (it.w || 1) * sz * 1.05;
    });
  let widths = measureAll(size);
  let total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  let k = maxW && total > maxW ? maxW / total : 1;
  const sz = size * k;
  widths = widths.map((w) => w * k);
  total *= k;
  let x = cx - total / 2;
  items.forEach((it, i) => {
    const w = widths[i];
    if (it.text) T(doc, it.font, it.text, { x, y, size: sz, align: 'left', tracking, caps: true });
    else if (it.sep) doc.fill('text', icons.dot(x + w / 2, y - sz * 0.35, sz * 0.1));
    else doc.fill('text', it.icon(x + w / 2, y - sz * 0.36, iconS * k));
    x += w + gap * k;
  });
}

function statInline(c, f) {
  const items = [];
  c.stats.forEach((st, i) => {
    if (i > 0) items.push({ sep: true });
    if (st.icon) items.push({ icon: st.icon, w: st.iconWidth || 1 });
    items.push({ text: st.inline, font: f.body });
  });
  return items;
}

// --------------------------------------------------------------------------
// Summit: art on top, title, location, stats row with icons, coordinates.

function summit(doc, c, f, o, art) {
  const { W, H } = doc;
  const u = Math.min(W, H);
  const m = u * 0.075;
  const innerW = W - 2 * m;
  if (o.border) doc.stroke('frame', rectPath(m * 0.42, m * 0.42, W - m * 0.84, H - m * 0.84, o.cornerRadius));

  let y = H - m;
  if (c.coords) {
    const size = u * 0.028;
    T(doc, f.body, c.coords, { x: W / 2, y, size, tracking: 0.2, caps: true, align: 'center' });
    y -= size + u * 0.04;
  }

  if (c.stats.length) {
    const n = c.stats.length;
    const colW = innerW / n;
    const iconS = u * 0.062;
    const valS = u * (n > 3 ? 0.04 : 0.046);
    const labS = u * 0.022;
    const labY = y;
    const valY = labY - labS * 1.7;
    const iconY = valY - valS * 1.0 - iconS * 0.62;
    c.stats.forEach((st, i) => {
      const cx = m + colW * (i + 0.5);
      if (st.icon) doc.fill('text', st.icon(cx, iconY, iconS));
      valueWithUnit(doc, f, st, cx, valY, valS, colW * 0.9);
      const ls = fitSize(f.body, st.label, colW * 0.92, labS, { tracking: 0.16, caps: true });
      T(doc, f.body, st.label, { x: cx, y: labY, size: ls, tracking: 0.16, caps: true });
      if (i > 0 && o.dividers) {
        const x = m + colW * i;
        doc.stroke('frame', pathData([[[x, iconY - iconS * 0.4], [x, labY]]]));
      }
    });
    y = iconY - iconS * 0.55 - u * 0.045;
  }

  if (c.personal) {
    const size = fitSize(f.script, c.personal, innerW * 0.9, u * 0.075);
    const r = T(doc, f.script, c.personal, { x: W / 2, y: y - size * 0.15, size });
    y -= size * 0.95;
    void r;
  }

  if (c.subtitle) {
    const size = fitSize(f.body, c.subtitle, innerW, u * 0.032, { tracking: 0.32, caps: true });
    T(doc, f.body, c.subtitle, { x: W / 2, y, size, tracking: 0.32, caps: true });
    y -= size + u * 0.035;
  }

  if (c.title) {
    const opts = { tracking: 0.04, smallCaps: o.smallCaps };
    const size = fitSize(f.title, c.title, innerW, u * 0.12 * o.titleScale, opts);
    const r = T(doc, f.title, c.title, { x: W / 2, y, size, ...opts });
    y -= r.capHeight + u * 0.055;
  }

  const top = o.border ? m * 0.9 : m * 0.7;
  art(doc, { x: m, y: top, w: innerW, h: Math.max(5, y - top) });
}

// --------------------------------------------------------------------------
// Topo: map-style checkered neatline, contour map, title cartouche.

function topo(doc, c, f, o, art) {
  const { W, H } = doc;
  const u = Math.min(W, H);
  const m = u * 0.05;
  const band = u * 0.022;
  const outer = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  const inner = { x: m + band, y: m + band, w: outer.w - 2 * band, h: outer.h - 2 * band };
  doc.stroke('frame', rectPath(outer.x, outer.y, outer.w, outer.h));
  doc.stroke('frame', rectPath(inner.x, inner.y, inner.w, inner.h));

  // Alternating filled blocks along the neatline, like a printed map border.
  const seg = u * 0.075;
  const blocks = [];
  const nx = Math.max(2, Math.round(inner.w / seg));
  const ny = Math.max(2, Math.round(inner.h / seg));
  const sx = inner.w / nx;
  const sy = inner.h / ny;
  for (let i = 0; i < nx; i += 2) {
    blocks.push(rectPath(inner.x + i * sx, outer.y, sx, band));
    blocks.push(rectPath(inner.x + inner.w - (i + 1) * sx, inner.y + inner.h, sx, band));
  }
  for (let j = 0; j < ny; j += 2) {
    blocks.push(rectPath(inner.x + inner.w, inner.y + j * sy, band, sy));
    blocks.push(rectPath(outer.x, inner.y + inner.h - (j + 1) * sy, band, sy));
  }
  doc.fill('text', blocks.join(''));

  // Cartouche.
  const pad = u * 0.03;
  const cw = Math.min(inner.w * 0.82, inner.w - 2 * pad);
  const titleOpts = { tracking: 0.05, smallCaps: o.smallCaps };
  const tSize = fitSize(f.title, c.title, cw - 2 * pad, u * 0.085 * o.titleScale, titleOpts);
  const tCap = layoutText(f.title, c.title || 'X', { size: tSize, ...titleOpts }).capHeight;
  const sSize = u * 0.03;
  const kSize = u * 0.022;
  const lines = [];
  lines.push({ kind: 'title', h: tCap });
  if (c.subtitle) lines.push({ kind: 'subtitle', h: kSize * 0.75 });
  if (c.stats.length) lines.push({ kind: 'stats', h: sSize * 0.75 });
  if (c.coords) lines.push({ kind: 'coords', h: kSize * 0.75 });
  const gapL = u * 0.022;
  const ch = pad * 2 + lines.reduce((a, l) => a + l.h, 0) + gapL * (lines.length - 1);
  const card = { x: (W - cw) / 2, y: inner.y + inner.h - ch - u * 0.045, w: cw, h: ch };
  doc.stroke('frame', rectPath(card.x, card.y, card.w, card.h));
  doc.stroke('frame', rectPath(card.x + 0.8, card.y + 0.8, card.w - 1.6, card.h - 1.6));
  let y = card.y + pad;
  for (const l of lines) {
    y += l.h;
    if (l.kind === 'title') T(doc, f.title, c.title, { x: W / 2, y, size: tSize, ...titleOpts });
    if (l.kind === 'subtitle') T(doc, f.body, c.subtitle, { x: W / 2, y, size: fitSize(f.body, c.subtitle, cw - 2 * pad, kSize, { tracking: 0.3, caps: true }), tracking: 0.3, caps: true });
    if (l.kind === 'stats') inlineRow(doc, statInline(c, f), W / 2, y, sSize, cw - 2 * pad);
    if (l.kind === 'coords') T(doc, f.body, c.coords, { x: W / 2, y, size: fitSize(f.body, c.coords, cw - 2 * pad, kSize, { tracking: 0.2 }), tracking: 0.2 });
    y += gapL;
  }

  // North arrow (plan view only).
  const holes = [{ type: 'rect', x: card.x - 1.2, y: card.y - 1.2, w: card.w + 2.4, h: card.h + 2.4 }];
  if (c.northAngle != null) {
    const nr = u * 0.045;
    const ncx = inner.x + inner.w - nr - u * 0.03;
    const ncy = inner.y + nr + u * 0.03;
    doc.stroke('frame', circlePath(ncx, ncy, nr));
    doc.fill('text', rotatePath(icons.northArrow(0, 0, nr * 1.3), c.northAngle, ncx, ncy));
    holes.push({ type: 'circle', cx: ncx, cy: ncy, r: nr + 0.8 });
  }

  const clip = { type: 'rect', x: inner.x + 0.6, y: inner.y + 0.6, w: inner.w - 1.2, h: inner.h - 1.2 };
  const box = { x: inner.x + u * 0.05, y: inner.y + u * 0.05, w: inner.w - u * 0.1, h: card.y - inner.y - u * 0.08 };
  art(doc, box, { shape: clip, holes });
}

/** Rotate absolute path data (M/L/Z only) by deg around origin, then translate. */
function rotatePath(d, deg, tx, ty) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, cmd, x, y) => {
    const px = +x;
    const py = +y;
    return `${cmd}${fmt(tx + px * cos - py * sin)} ${fmt(ty + px * sin + py * cos)}`;
  });
}

// --------------------------------------------------------------------------
// Badge: circular seal, title on the top arc, stats on the bottom arc.

function badge(doc, c, f, o, art) {
  const { W, H } = doc;
  const D = Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const r1 = D / 2 - D * 0.04;
  const bandW = D * 0.135;
  const r2 = r1 - bandW;
  const rMid = (r1 + r2) / 2;
  doc.stroke('frame', circlePath(cx, cy, r1));
  doc.stroke('frame', circlePath(cx, cy, r2));
  if (o.border) doc.stroke('frame', circlePath(cx, cy, r1 + D * 0.014));

  // Title over the top.
  const titleOpts = { tracking: 0.1, smallCaps: o.smallCaps };
  let tSize = bandW * 0.62 * o.titleScale;
  for (let i = 0; i < 6; i++) {
    const lay = layoutText(f.title, c.title || '', { size: tSize, ...titleOpts });
    const rBase = rMid - lay.capHeight / 2;
    const maxW = rBase * ((150 * Math.PI) / 180);
    if (lay.width <= maxW) break;
    tSize *= maxW / lay.width;
  }
  const tCap = layoutText(f.title, c.title || 'X', { size: tSize, ...titleOpts }).capHeight;
  if (c.title) {
    doc.fill('text', arcTextPath(f.title, c.title, { cx, cy, r: rMid - tCap / 2, side: 'top', size: tSize, ...titleOpts }).d);
  }

  // Stats under the bottom, split around the max-difficulty symbol.
  const sSize = bandW * 0.3;
  const parts = c.stats.filter((s) => s.id !== 'difficulty').map((s) => s.inline);
  const left = parts.slice(0, Math.ceil(parts.length / 2)).join('  ·  ');
  const right = parts.slice(Math.ceil(parts.length / 2)).join('  ·  ');
  const sCap = layoutText(f.body, 'X', { size: sSize }).capHeight;
  const rB = rMid + sCap / 2;
  const iconS = sSize * 1.5;
  const diff = c.stats.find((s) => s.id === 'difficulty');
  const centerIcon = diff ? diff.icon : (x, y, s) => icons.star(x, y, s * 0.8);
  const centerW = (diff ? diff.iconWidth || 1 : 1) * iconS;
  doc.fill('text', centerIcon(cx, cy + rMid, iconS));
  const maxW = rB * ((62 * Math.PI) / 180);
  let k = 1;
  for (const str of [left, right]) {
    const w = str ? layoutText(f.body, str, { size: sSize, tracking: 0.14, caps: true }).width : 0;
    if (w > maxW) k = Math.min(k, maxW / w);
  }
  const sOpts = { size: sSize * k, tracking: 0.14, caps: true };
  const halfGap = centerW / 2 + sSize * 0.7;
  for (const [str, dir] of [[left, 1], [right, -1]]) {
    if (!str) continue;
    const w = layoutText(f.body, str, sOpts).width;
    const ang = 180 + dir * (((halfGap + w / 2) / rB) * 180) / Math.PI;
    doc.fill('text', arcTextPath(f.body, str, { cx, cy, r: rB, side: 'bottom', angle: ang, ...sOpts }).d);
  }

  // Ornaments at 3 and 9 o'clock.
  for (const sx of [-1, 1]) doc.fill('text', icons.star(cx + sx * rMid, cy, bandW * 0.32));

  // Inner field: art, with the location / coordinates below it.
  const rIn = r2 - D * 0.012;
  const holes = [];
  let bottomY = cy + rIn;
  const lowerLines = [c.coords, c.subtitle].filter(Boolean);
  if (lowerLines.length) {
    const ls = D * 0.026;
    let y = cy + rIn * 0.8;
    for (const line of lowerLines.slice(0, 2)) {
      const chord = 2 * Math.sqrt(Math.max(0, rIn * rIn - (y - cy) ** 2)) * 0.86;
      const size = fitSize(f.body, line, chord, ls, { tracking: 0.18, caps: true });
      const r = T(doc, f.body, line, { x: cx, y, size, tracking: 0.18, caps: true });
      holes.push({ type: 'rect', x: cx - r.width / 2 - 1, y: y - size * 0.85, w: r.width + 2, h: size * 1.15 });
      bottomY = Math.min(bottomY, y - size - 1);
      y -= size * 1.55;
    }
  }
  if (c.personal) {
    const size = fitSize(f.script, c.personal, rIn * 1.3, D * 0.06);
    const y = cy - rIn * 0.58;
    const r = T(doc, f.script, c.personal, { x: cx, y, size });
    holes.push({ type: 'rect', x: cx - r.width / 2 - 1, y: y - size * 0.8, w: r.width + 2, h: size * 1.1 });
  }
  const artTop = c.personal ? cy - rIn * 0.5 : cy - rIn * 0.78;
  const box = { x: cx - rIn * 0.82, y: artTop, w: rIn * 1.64, h: Math.max(5, bottomY - artTop - D * 0.02) };
  art(doc, box, { shape: { type: 'circle', cx, cy, r: rIn - 0.4 }, holes });
}

// --------------------------------------------------------------------------
// Lift ticket.

function ticketOutline(W, H, inset, px, nr, cr) {
  const x0 = inset, y0 = inset, x1 = W - inset, y1 = H - inset;
  const f = fmt;
  return (
    `M${f(x0 + cr)} ${f(y0)}L${f(px - nr)} ${f(y0)}A${f(nr)} ${f(nr)} 0 0 0 ${f(px + nr)} ${f(y0)}` +
    `L${f(x1 - cr)} ${f(y0)}A${f(cr)} ${f(cr)} 0 0 1 ${f(x1)} ${f(y0 + cr)}` +
    `L${f(x1)} ${f(y1 - cr)}A${f(cr)} ${f(cr)} 0 0 1 ${f(x1 - cr)} ${f(y1)}` +
    `L${f(px + nr)} ${f(y1)}A${f(nr)} ${f(nr)} 0 0 0 ${f(px - nr)} ${f(y1)}` +
    `L${f(x0 + cr)} ${f(y1)}A${f(cr)} ${f(cr)} 0 0 1 ${f(x0)} ${f(y1 - cr)}` +
    `L${f(x0)} ${f(y0 + cr)}A${f(cr)} ${f(cr)} 0 0 1 ${f(x0 + cr)} ${f(y0)}Z`
  );
}

function ticket(doc, c, f, o, art) {
  const { W, H } = doc;
  const u = H;
  const m = u * 0.075;
  const inset = u * 0.03;
  const px = W * 0.215;
  const nr = u * 0.065;
  const cr = u * 0.06;
  doc.stroke('frame', ticketOutline(W, H, inset, px, nr, cr));
  if (o.border) doc.stroke('frame', ticketOutline(W, H, inset + u * 0.035, px, nr + u * 0.035, Math.max(0.5, cr - u * 0.035)));

  // Perforation.
  const dots = [];
  const dy0 = inset + nr + u * 0.04;
  const dy1 = H - inset - nr - u * 0.04;
  const n = Math.max(2, Math.round((dy1 - dy0) / (u * 0.04)));
  for (let i = 0; i <= n; i++) dots.push(icons.dot(px, dy0 + ((dy1 - dy0) * i) / n, u * 0.009));
  doc.fill('text', dots.join(''));

  // Stub.
  const sc = px / 2 + inset / 2;
  const iconS = Math.min(px * 0.36, u * 0.13);
  const symbol = c.maxDifficulty;
  if (symbol) {
    const w = icons.difficultyIconWidth(symbol.symbol, iconS);
    const s = w > px * 0.62 ? (iconS * px * 0.62) / w : iconS;
    doc.fill('text', icons.difficultyIcon(symbol.symbol, sc, m + inset + s * 0.45, s));
    doc.fill('text', icons.difficultyIcon(symbol.symbol, sc, H - m - inset - s * 0.45, s));
  }
  if (c.stub) {
    const span = H - 2 * (m + inset + iconS * 1.25);
    const size = fitSize(f.title, c.stub, span, px * 0.34, { tracking: 0.12, caps: true });
    const cap = layoutText(f.title, c.stub, { size }).capHeight;
    T(doc, f.title, c.stub, { x: sc + cap / 2, y: H / 2, size, tracking: 0.12, caps: true, rotate: -90 });
  }

  // Main panel.
  const x0 = px + m;
  const x1 = W - inset - m * 0.9;
  const mw = x1 - x0;
  let y = inset + m;
  if (c.header) {
    const hs = u * 0.042;
    const hOpts = { tracking: 0.32, caps: true };
    const r = T(doc, f.body, c.header, { x: x0 + mw / 2, y: y + hs * 0.72, size: fitSize(f.body, c.header, mw * 0.72, hs, hOpts), ...hOpts });
    const ly = y + hs * 0.36;
    const gap = u * 0.03;
    doc.stroke('frame', pathData([
      [[x0, ly], [x0 + mw / 2 - r.width / 2 - gap, ly]],
      [[x0 + mw / 2 + r.width / 2 + gap, ly], [x1, ly]],
    ]));
    y += hs + u * 0.045;
  }
  const titleOpts = { tracking: 0.03, smallCaps: o.smallCaps };
  const tSize = fitSize(f.title, c.title, mw, u * 0.17 * o.titleScale, titleOpts);
  const tr = T(doc, f.title, c.title, { x: x0, y: y + layoutText(f.title, c.title || 'X', { size: tSize, ...titleOpts }).capHeight, size: tSize, align: 'left', ...titleOpts });
  y += (tr ? tr.capHeight : 0) + u * 0.04;
  if (c.subtitle) {
    const ss = u * 0.036;
    T(doc, f.body, c.subtitle, { x: x0, y: y + ss * 0.72, size: fitSize(f.body, c.subtitle, mw, ss, { tracking: 0.28, caps: true }), tracking: 0.28, caps: true, align: 'left' });
    y += ss + u * 0.03;
  }
  if (c.personal) {
    const ps = fitSize(f.script, c.personal, mw * 0.55, u * 0.08);
    T(doc, f.script, c.personal, { x: x0, y: y + ps * 0.7, size: ps, align: 'left' });
    y += ps * 0.9;
  }

  // Footer.
  const fs = u * 0.03;
  const footY = H - inset - m;
  if (c.coords) T(doc, f.body, c.coords, { x: x0, y: footY, size: fitSize(f.body, c.coords, mw * 0.6, fs, { tracking: 0.12 }), tracking: 0.12, align: 'left' });
  if (c.serial) T(doc, f.bold, c.serial, { x: x1, y: footY, size: fs, tracking: 0.12, align: 'right' });
  const ruleY = footY - fs - u * 0.035;
  doc.stroke('frame', pathData([[[x0, ruleY], [x1, ruleY]]]));

  // Stats with dotted leaders (left) and art (right).
  const top = y + u * 0.02;
  const bottom = ruleY - u * 0.035;
  const colW = c.stats.length ? mw * 0.47 : 0;
  if (c.stats.length) {
    const rowH = Math.min(u * 0.085, (bottom - top) / c.stats.length);
    const rs = rowH * 0.48;
    c.stats.forEach((st, i) => {
      const by = top + rowH * (i + 0.5) + rs * 0.36;
      const label = st.id === 'difficulty' ? 'Toughest' : st.label;
      const lab = T(doc, f.body, label, { x: x0, y: by, size: rs, tracking: 0.12, caps: true, align: 'left' });
      const valueText = st.unit ? `${st.value} ${st.unit}` : st.value;
      let vEnd = x0 + colW;
      if (st.id === 'difficulty' && st.icon) {
        const iw = (st.iconWidth || 1) * rs * 1.25;
        doc.fill('text', st.icon(vEnd - iw / 2, by - rs * 0.36, rs * 1.25));
        vEnd -= iw + rs * 0.4;
      }
      const avail = vEnd - (x0 + (lab ? lab.width : 0) + rs * 1.2);
      const vw = layoutText(f.bold, valueText, { size: rs, tracking: 0.04 }).width;
      // Shrink a little to fit; if that's not enough, the difficulty row shows just its symbol.
      const vs = vw > avail ? rs * (avail / vw) : rs;
      const val = vs >= rs * 0.8 ? T(doc, f.bold, valueText, { x: vEnd, y: by, size: vs, tracking: 0.04, align: 'right' }) : null;
      const d0 = x0 + (lab ? lab.width : 0) + rs * 0.5;
      const d1 = vEnd - (val ? val.width : 0) - rs * 0.5;
      const step = rs * 0.42;
      const leader = [];
      for (let x = d0; x <= d1; x += step) leader.push(icons.dot(x, by - rs * 0.08, rs * 0.07));
      doc.fill('text', leader.join(''));
    });
  }
  const artX = x0 + colW + (colW ? u * 0.05 : 0);
  art(doc, { x: artX, y: top, w: x1 - artX, h: Math.max(5, bottom - top) });
  doc.cutShape = ticketOutline(W, H, 0, px, nr + inset, cr + inset);
}

const LAYOUTS = { summit, topo, badge, ticket };

/** Outline of the physical blank, used for the optional cut / alignment layer. */
export function blankOutline(template, W, H, cornerRadius = 0) {
  if (template.shape === 'circle') return circlePath(W / 2, H / 2, Math.min(W, H) / 2);
  if (template.shape === 'ticket') {
    const u = H;
    return ticketOutline(W, H, 0, W * 0.215, u * 0.065 + u * 0.03, u * 0.06 + u * 0.03);
  }
  return rectPath(0, 0, W, H, cornerRadius);
}

export function renderTemplate(template, doc, c, f, o, art) {
  LAYOUTS[template.id](doc, c, f, o, art);
}
