// Text → SVG path outlines via opentype.js, so exported files never depend on
// fonts being installed in xTool Studio.

import { fmt } from './geometry.js';

/**
 * A FontSet is an ordered list of opentype Font objects; each character uses the
 * first font that has a glyph for it (e.g. latin, then latin-ext).
 */
export function makeFontSet(fonts) {
  return { fonts, primary: fonts[0] };
}

// Substitutes for typographic characters some display fonts lack.
const CHAR_FALLBACK = { '′': "'", '″': '"', '·': '•', '•': '-', '—': '-', '–': '-', '’': "'", '‘': "'", '“': '"', '”': '"' };

function pickGlyph(fontSet, ch) {
  for (let c = ch, n = 0; c && n < 3; c = CHAR_FALLBACK[c], n++) {
    for (const font of fontSet.fonts) {
      const g = font.charToGlyph(c);
      if (g && g.index !== 0) return { font, glyph: g };
    }
  }
  return null;
}

/**
 * Lay out a string into glyph placements.
 * opts: { size, tracking (em), smallCaps, caps }
 */
export function layoutText(fontSet, text, opts) {
  const { size, tracking = 0, smallCaps = false, caps = false } = opts;
  const placed = [];
  let x = 0;
  let prev = null;
  for (let ch of Array.from(String(text ?? ''))) {
    let s = size;
    if (smallCaps && ch !== ch.toUpperCase()) {
      ch = ch.toUpperCase();
      s = size * 0.78;
    } else if (caps) {
      ch = ch.toUpperCase();
    }
    const hit = pickGlyph(fontSet, ch);
    if (!hit) {
      if (/\s/.test(ch)) {
        x += size * 0.28 + tracking * size;
      }
      prev = null;
      continue;
    }
    const scale = s / hit.font.unitsPerEm;
    if (prev && prev.font === hit.font && prev.size === s) {
      x += hit.font.getKerningValue(prev.glyph, hit.glyph) * scale;
    }
    placed.push({ ...hit, x, size: s });
    x += hit.glyph.advanceWidth * scale + tracking * size;
    prev = { ...hit, size: s };
  }
  const width = placed.length ? x - tracking * size : 0;
  const f = fontSet.primary;
  return {
    placed,
    width,
    ascent: (f.ascender / f.unitsPerEm) * size,
    descent: (-f.descender / f.unitsPerEm) * size,
    capHeight: capHeight(f) * size,
  };
}

function capHeight(font) {
  const os2 = font.tables.os2;
  if (os2 && os2.sCapHeight) return os2.sCapHeight / font.unitsPerEm;
  const g = font.charToGlyph('H');
  const bb = g.getBoundingBox();
  return bb.y2 / font.unitsPerEm || 0.7;
}

/**
 * Actual ink extent of laid-out text: how far glyphs reach above and below
 * the baseline (script swashes often exceed the font's cap height).
 */
export function inkExtent(fontSet, text, opts) {
  const lay = layoutText(fontSet, text, opts);
  let top = 0;
  let bottom = 0;
  for (const p of lay.placed) {
    const bb = p.glyph.getBoundingBox();
    const scale = p.size / p.font.unitsPerEm;
    top = Math.max(top, bb.y2 * scale);
    bottom = Math.max(bottom, -bb.y1 * scale);
  }
  return { top, bottom, width: lay.width };
}

export function measure(fontSet, text, opts) {
  return layoutText(fontSet, text, opts).width;
}

/** Largest size <= maxSize whose width fits maxWidth. */
export function fitSize(fontSet, text, maxWidth, maxSize, opts = {}) {
  const w = measure(fontSet, text, { ...opts, size: maxSize });
  if (w <= maxWidth || w === 0) return maxSize;
  return maxSize * (maxWidth / w);
}

function commandsToPath(commands, map) {
  let d = '';
  for (const c of commands) {
    if (c.type === 'Z') {
      d += 'Z';
      continue;
    }
    const [x, y] = map(c.x, c.y);
    if (c.type === 'M') d += `M${fmt(x)} ${fmt(y)}`;
    else if (c.type === 'L') d += `L${fmt(x)} ${fmt(y)}`;
    else if (c.type === 'Q') {
      const [x1, y1] = map(c.x1, c.y1);
      d += `Q${fmt(x1)} ${fmt(y1)} ${fmt(x)} ${fmt(y)}`;
    } else if (c.type === 'C') {
      const [x1, y1] = map(c.x1, c.y1);
      const [x2, y2] = map(c.x2, c.y2);
      d += `C${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`;
    }
  }
  return d;
}

/**
 * Straight text. (x, y) is the baseline anchor; align = left | center | right.
 * Returns { d, width, ascent, descent, capHeight }.
 */
export function textPath(fontSet, text, opts) {
  const { x = 0, y = 0, align = 'center', rotate = 0 } = opts;
  const lay = layoutText(fontSet, text, opts);
  const x0 = align === 'center' ? -lay.width / 2 : align === 'right' ? -lay.width : 0;
  const cos = Math.cos((rotate * Math.PI) / 180);
  const sin = Math.sin((rotate * Math.PI) / 180);
  const map = (px, py) => [x + px * cos - py * sin, y + px * sin + py * cos];
  let d = '';
  for (const p of lay.placed) {
    const path = p.glyph.getPath(x0 + p.x, 0, p.size);
    d += commandsToPath(path.commands, map);
  }
  return { ...lay, d };
}

/**
 * Text bent along a circle. side 'top' reads clockwise over the top with glyphs
 * pointing outward; 'bottom' reads left-to-right under the centre with glyphs
 * pointing inward. r is the baseline radius; angle (deg) is the centre of the
 * text measured clockwise from 12 o'clock.
 */
export function arcTextPath(fontSet, text, opts) {
  const { cx, cy, r, side = 'top', angle = side === 'top' ? 0 : 180 } = opts;
  const lay = layoutText(fontSet, text, opts);
  const a0 = (angle * Math.PI) / 180;
  const half = lay.width / 2;
  const map =
    side === 'top'
      ? (px, py) => {
          const a = a0 + (px - half) / r;
          const rho = r - py;
          return [cx + rho * Math.sin(a), cy - rho * Math.cos(a)];
        }
      : (px, py) => {
          const a = a0 - (px - half) / r;
          const rho = r + py;
          return [cx + rho * Math.sin(a), cy - rho * Math.cos(a)];
        };
  let d = '';
  for (const p of lay.placed) {
    const path = p.glyph.getPath(p.x, 0, p.size);
    d += commandsToPath(path.commands, map);
  }
  return { ...lay, d, sweep: lay.width / r };
}
