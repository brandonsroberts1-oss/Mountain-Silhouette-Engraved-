// Fits scene line art into a box on the design (mm, y-down), clips it, and
// emits it onto layers.

import { clipPolylines, simplify, polylineLength, dashPolyline, ribbon, pathData, bounds } from './geometry.js';
import { difficultyClass } from '../format.js';
import * as icons from './icons.js';

export class Doc {
  constructor(W, H) {
    this.W = W;
    this.H = H;
    this.items = [];
    this.cut = null;
  }

  fill(layer, d) {
    if (d) this.items.push({ layer, kind: 'fill', d });
  }

  stroke(layer, d, weight = 1) {
    if (d) this.items.push({ layer, kind: 'stroke', d, weight });
  }
}

export const DEFAULT_ART = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  layerByDifficulty: false,
  liftStyle: 'dashed', // dashed | solid | none
  highlight: '',
  highlightMarker: 'star', // star | heart | none
};

function cleanup(lines, region, minLen) {
  return clipPolylines(lines, region)
    .map((l) => simplify(l, 0.02))
    .filter((l) => polylineLength(l) >= minLen);
}

/**
 * Draw `scene` into `box` ({x, y, w, h} mm). `region` is the clip region
 * ({ shape, holes }); defaults to the box. Returns the transform used.
 */
export function placeArt(doc, scene, box, region, opts = {}) {
  const o = { ...DEFAULT_ART, ...opts };
  region = region || { shape: { type: 'rect', ...box } };
  const fb = scene.focus;
  if (!Number.isFinite(fb.minX)) return null;
  const fw = Math.max(fb.maxX - fb.minX, 1e-6);
  const fh = Math.max(fb.maxY - fb.minY, 1e-6);
  const s = Math.min(box.w / fw, box.h / fh) * o.zoom;
  const cx = box.x + box.w / 2 + o.offsetX * box.w;
  const cy = box.y + box.h / 2 + o.offsetY * box.h;
  const mx = (fb.minX + fb.maxX) / 2;
  const my = (fb.minY + fb.maxY) / 2;
  const tf = ([x, y]) => [cx + (x - mx) * s, cy - (y - my) * s];
  const map = (lines) => lines.map((l) => l.map(tf));
  const minLen = 0.5;

  if (scene.terrain.length) {
    const t = cleanup(map(scene.terrain), region, minLen);
    doc.stroke('terrain', pathData(t), 0.7);
  }

  if (o.liftStyle !== 'none') {
    for (const lift of scene.lifts) {
      let lines = cleanup(map(lift.lines), region, minLen);
      if (o.liftStyle === 'dashed') lines = lines.flatMap((l) => dashPolyline(l, 1.1, 0.7));
      doc.stroke('lifts', pathData(lines), 0.8);
    }
  }

  let highlightLines = [];
  for (const trail of scene.trails) {
    const lines = cleanup(map(trail.lines), region, minLen);
    if (!lines.length) continue;
    const isHighlight = o.highlight && trail.name && trail.name === o.highlight;
    if (isHighlight) {
      highlightLines.push(...lines);
      continue;
    }
    const layer = o.layerByDifficulty ? `trails-${difficultyClass(trail.difficulty)}` : 'trails';
    doc.stroke(layer, pathData(lines));
  }

  if (highlightLines.length) {
    const width = Math.max(0.35, Math.min(box.w, box.h) * 0.006);
    const outlines = highlightLines.filter((l) => l.length > 1).map((l) => ribbon(l, width));
    doc.stroke('highlight', pathData(outlines, 3, true));
    if (o.highlightMarker !== 'none') {
      // Marker sits just above the highest point of the run.
      let top = null;
      for (const l of highlightLines) for (const p of l) if (!top || p[1] < top[1]) top = p;
      const size = Math.max(2.2, Math.min(box.w, box.h) * 0.06);
      const fn = o.highlightMarker === 'heart' ? icons.heart : icons.star;
      doc.fill('text', fn(top[0], top[1] - size * 0.75, size));
    }
  }

  return { scale: s, transform: tf };
}

/** Bounds of the placed art (mm) for layout decisions. */
export function artBounds(scene, box, opts = {}) {
  const fb = scene.focus;
  const fw = Math.max(fb.maxX - fb.minX, 1e-6);
  const fh = Math.max(fb.maxY - fb.minY, 1e-6);
  const s = Math.min(box.w / fw, box.h / fh) * (opts.zoom || 1);
  return { w: fw * s, h: fh * s };
}

export { bounds };
