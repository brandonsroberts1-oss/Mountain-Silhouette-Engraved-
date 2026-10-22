// SVG serialisation for preview (material simulation) and laser export.
//
// Export rules for xTool Studio / laser software:
//  - width/height in mm with a matching viewBox, so it imports at true size
//  - only <g> and filled <path>s; no <text>, <use>, clipPath, mask, CSS or
//    dasharray, and no hairlines: every line is outlined to its engraved width
//  - one colour per layer, so each can get its own power/speed

import { strokePaths, fillPaths, clip, pathsToD } from './outline.js';

export const LAYERS = [
  { id: 'terrain', name: 'Terrain lines', op: 'Engrave · lower power', color: '#FF00FF', kind: 'stroke' },
  { id: 'trails', name: 'Ski trails', op: 'Engrave', color: '#0000FF', kind: 'stroke' },
  { id: 'trails-easy', name: 'Trails · easy', op: 'Engrave', color: '#00A651', kind: 'stroke' },
  { id: 'trails-intermediate', name: 'Trails · intermediate', op: 'Engrave', color: '#0072FF', kind: 'stroke' },
  { id: 'trails-advanced', name: 'Trails · advanced', op: 'Engrave', color: '#5B2C83', kind: 'stroke' },
  { id: 'trails-expert', name: 'Trails · expert', op: 'Engrave', color: '#E87500', kind: 'stroke' },
  { id: 'trails-other', name: 'Trails · unrated', op: 'Engrave', color: '#0000FF', kind: 'stroke' },
  { id: 'lifts', name: 'Lifts', op: 'Engrave', color: '#00A0C8', kind: 'stroke' },
  { id: 'highlight', name: 'Favourite run', op: 'Engrave', color: '#FF7F00', kind: 'stroke' },
  { id: 'frame', name: 'Frames & rules', op: 'Engrave', color: '#008080', kind: 'stroke' },
  { id: 'text', name: 'Text & icons', op: 'Engrave', color: '#000000', kind: 'fill' },
  { id: 'cut', name: 'Blank outline', op: 'Cut / frame guide', color: '#FF0000', kind: 'stroke' },
];

export const MATERIALS = {
  slate: { name: 'Slate', bg: '#2a2c2f', ink: '#e4e2dc', texture: 'slate' },
  wood: { name: 'Light wood', bg: '#e2c49c', ink: '#4a2a12', texture: 'wood' },
  walnut: { name: 'Walnut', bg: '#6b4a33', ink: '#f1dcc0', texture: 'wood' },
  leather: { name: 'Leather', bg: '#8a5a3a', ink: '#3a2216', texture: 'none' },
  acrylic: { name: 'Black acrylic', bg: '#121212', ink: '#f5f5f5', texture: 'none' },
  layers: { name: 'Layer colours', bg: '#ffffff', ink: null, texture: 'none' },
};

const esc = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);

function grouped(doc) {
  const map = new Map();
  for (const it of doc.items) {
    if (!map.has(it.layer)) map.set(it.layer, []);
    map.get(it.layer).push(it);
  }
  return map;
}

function layerColor(id, colorMode) {
  if (colorMode === 'mono') return id === 'cut' ? '#FF0000' : '#000000';
  return (LAYERS.find((l) => l.id === id) || LAYERS[1]).color;
}

/** Layers present in a doc, in canonical order (every layer engraves). */
export function usedLayers(doc, includeCut) {
  const ids = new Set(doc.items.map((it) => it.layer));
  return LAYERS.filter((l) => (l.id === 'cut' ? includeCut && doc.cut : ids.has(l.id)));
}

// Art layers from top to bottom. Where they overlap, the upper layer wins and
// is cut out of the ones beneath, so no spot is burned twice.
const ART_STACK = ['highlight', 'trails-expert', 'trails-advanced', 'trails-intermediate', 'trails-easy', 'trails-other', 'trails', 'lifts', 'terrain'];

/**
 * Engrave-ready geometry: every line outlined at its width, and shapes merged
 * so nothing overlaps (no double burns, same result under any fill rule).
 * Art and frame layers merge into one shape per layer; text stays one shape
 * per text item so it can still be moved individually in xTool Studio.
 */
export function engraveDoc(doc) {
  const shapes = (it) => (it.kind === 'stroke' ? strokePaths(it.d, it.width) : fillPaths(it.d));
  const layers = grouped(doc);
  const merged = new Map();
  let occupied = [];
  for (const id of ART_STACK) {
    if (!layers.has(id)) continue;
    let paths = clip('union', layers.get(id).flatMap(shapes));
    if (occupied.length) paths = clip('difference', paths, occupied);
    merged.set(id, paths);
    occupied = clip('union', occupied.concat(paths));
  }
  const out = [];
  for (const [layer, items] of layers) {
    if (layer === 'text') {
      for (const it of items) out.push({ layer, d: pathsToD(clip('union', shapes(it))), meta: it.meta });
    } else {
      out.push({ layer, d: pathsToD(merged.get(layer) || clip('union', items.flatMap(shapes))) });
    }
  }
  return out.filter((e) => e.d);
}

/**
 * opts: { mode: 'export' | 'preview', colorMode: 'layers' | 'mono',
 *         material, includeCut, title, blank }
 */
export function buildSvg(doc, opts) {
  const { mode = 'export', colorMode = 'layers', material = 'slate', includeCut = false } = opts;
  const W = +doc.W.toFixed(3);
  const H = +doc.H.toFixed(3);
  const mat = MATERIALS[material] || MATERIALS.slate;
  const preview = mode === 'preview';
  const ink = (id) => (preview && mat.ink ? mat.ink : layerColor(id, colorMode));

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`
  );
  if (opts.title) out.push(`<title>${esc(opts.title)}</title>`);

  if (preview) {
    // Lines are drawn at their engraved width (round ends/joins), which looks
    // exactly like the outlined export but renders much faster.
    out.push(previewBackground(doc, mat, opts.blank));
    for (const [id, items] of grouped(doc)) {
      const color = ink(id);
      const fade = id === 'terrain' && mat.ink ? ' opacity="0.8"' : '';
      out.push(`<g id="${id}" fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"${fade}>`);
      for (const it of items) {
        out.push(it.kind === 'fill' ? `<path d="${it.d}" stroke="none"/>` : `<path d="${it.d}" fill="none" stroke-width="${+it.width.toFixed(3)}"/>`);
      }
      out.push('</g>');
    }
  } else {
    let current = null;
    for (const e of engraveDoc(doc)) {
      if (e.layer !== current) {
        if (current) out.push('</g>');
        out.push(`<g id="${e.layer}" fill="${ink(e.layer)}" stroke="none">`);
        current = e.layer;
      }
      out.push(`<path d="${e.d}"/>`);
    }
    if (current) out.push('</g>');
  }

  if (includeCut && doc.cut) {
    const color = preview ? '#ff3b30' : '#FF0000';
    const dash = preview ? ' stroke-dasharray="1.5 1"' : '';
    out.push(`<g id="cut" fill="none" stroke="${color}" stroke-width="${preview ? 0.3 : 0.1}"${dash}><path d="${doc.cut}"/></g>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

function previewBackground(doc, mat, blank) {
  const parts = [];
  const shape = blank || `M0 0H${doc.W}V${doc.H}H0Z`;
  parts.push('<defs>');
  if (mat.texture === 'slate') {
    parts.push(
      '<filter id="tex" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.08 0.5" numOctaves="3" seed="7"/>' +
        '<feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.52  0 0 0 0.09 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>'
    );
  } else if (mat.texture === 'wood') {
    parts.push(
      '<filter id="tex" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.25" numOctaves="2" seed="3"/>' +
        '<feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.2  0 0 0 0 0.08  0 0 0 0.16 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>'
    );
  }
  parts.push('</defs>');
  parts.push(`<path d="${shape}" fill="${mat.bg}"/>`);
  if (mat.texture !== 'none') parts.push(`<path d="${shape}" filter="url(#tex)"/>`);
  return parts.join('');
}
