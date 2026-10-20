// SVG serialisation for preview (material simulation) and laser export.
//
// Export rules for xTool Studio / laser software:
//  - width/height in mm with a matching viewBox, so it imports at true size
//  - only <g> and <path>; no <text>, <use>, clipPath, mask, CSS or dasharray
//  - one colour per operation so each becomes its own layer

export const LAYERS = [
  { id: 'terrain', name: 'Terrain lines', op: 'Score (light)', color: '#FF00FF', kind: 'stroke' },
  { id: 'trails', name: 'Ski trails', op: 'Score', color: '#0000FF', kind: 'stroke' },
  { id: 'trails-easy', name: 'Trails · easy', op: 'Score', color: '#00A651', kind: 'stroke' },
  { id: 'trails-intermediate', name: 'Trails · intermediate', op: 'Score', color: '#0072FF', kind: 'stroke' },
  { id: 'trails-advanced', name: 'Trails · advanced', op: 'Score', color: '#5B2C83', kind: 'stroke' },
  { id: 'trails-expert', name: 'Trails · expert', op: 'Score', color: '#E87500', kind: 'stroke' },
  { id: 'trails-other', name: 'Trails · unrated', op: 'Score', color: '#0000FF', kind: 'stroke' },
  { id: 'lifts', name: 'Lifts', op: 'Score', color: '#00A0C8', kind: 'stroke' },
  { id: 'highlight', name: 'Favourite run', op: 'Score', color: '#FF7F00', kind: 'stroke' },
  { id: 'frame', name: 'Frames & rules', op: 'Score', color: '#008080', kind: 'stroke' },
  { id: 'text', name: 'Text & icons', op: 'Engrave (fill)', color: '#000000', kind: 'fill' },
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

/**
 * Layers present in a doc, in canonical order, with the operation that suits
 * them: filled shapes engrave, open lines score.
 */
export function usedLayers(doc, includeCut) {
  const kinds = new Map();
  for (const it of doc.items) {
    if (!kinds.has(it.layer)) kinds.set(it.layer, new Set());
    kinds.get(it.layer).add(it.kind);
  }
  const out = [];
  for (const l of LAYERS) {
    if (l.id === 'cut') {
      if (includeCut && doc.cut) out.push(l);
      continue;
    }
    const k = kinds.get(l.id);
    if (!k) continue;
    const op = k.has('fill') && k.has('stroke') ? 'Engrave + score' : k.has('fill') ? 'Engrave (fill)' : l.op;
    out.push({ ...l, op });
  }
  return out;
}

/**
 * opts: { mode: 'export' | 'preview', colorMode: 'layers' | 'mono',
 *         material, lineWeight (mm), includeCut, title }
 */
export function buildSvg(doc, opts) {
  const { mode = 'export', colorMode = 'layers', material = 'slate', lineWeight = 0.2, includeCut = false } = opts;
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
    out.push(previewBackground(doc, mat, opts.blank));
  }

  for (const [id, items] of grouped(doc)) {
    const color = ink(id);
    const fills = items.filter((i) => i.kind === 'fill');
    const strokes = items.filter((i) => i.kind === 'stroke');
    if (fills.length) {
      out.push(`<g id="${id}" fill="${color}" stroke="none">`);
      for (const it of fills) out.push(`<path d="${it.d}"/>`);
      out.push('</g>');
    }
    if (strokes.length) {
      const gid = fills.length ? `${id}-lines` : id;
      const sw = +(lineWeight * (strokes[0].weight || 1)).toFixed(3);
      const extra = preview && id === 'terrain' && mat.ink ? ' stroke-opacity="0.72"' : '';
      out.push(`<g id="${gid}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${extra}>`);
      for (const it of strokes) {
        const w = +(lineWeight * (it.weight || 1)).toFixed(3);
        out.push(w === sw ? `<path d="${it.d}"/>` : `<path d="${it.d}" stroke-width="${w}"/>`);
      }
      out.push('</g>');
    }
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
