// Fits scene line art into a box on the design (mm, y-down), clips it, and
// emits it onto layers.

import {
  clipPolylines, simplify, polylineLength, dashPolyline, ribbon, pathData, bounds,
  resample, strokeOutline, smoothPathData, lineMask, knockout,
} from './geometry.js';
import { difficultyClass } from '../format.js';
import * as icons from './icons.js';

export class Doc {
  constructor(W, H) {
    this.W = W;
    this.H = H;
    this.items = [];
    this.cut = null;
  }

  /** meta.touchesFrame: deliberately drawn against frame lines (e.g. map border blocks). */
  fill(layer, d, meta) {
    if (d) this.items.push({ layer, kind: 'fill', d, ...(meta ? { meta } : {}) });
  }

  /**
   * A line, engraved as a band of real width. `weight` scales the design's
   * line width (set at compose time); `width` (mm) overrides it.
   */
  stroke(layer, d, weight = 1, width) {
    if (d) this.items.push({ layer, kind: 'stroke', d, weight, ...(width ? { width } : {}) });
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
  trailStyle: 'bold', // bold (tapered) | line (even width); both engrave as filled shapes
  trailWidth: 0.4, // mm, bold style
  taper: true, // bold style: trails start fine at the top and swell downhill
  knockout: true, // leave a gap in terrain lines around trails
  lineWidth: 0.25, // mm, engraved width of terrain, lift and frame lines (set by compose)
};

// Terrain lines engrave a little finer than frames so trails stay dominant.
const TERRAIN_WEIGHT = 0.8;

function cleanup(lines, region, minLen) {
  return clipPolylines(lines, region)
    .map((l) => simplify(l, 0.02))
    .filter((l) => polylineLength(l) >= minLen);
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Solid engraved stroke for a trail: a filled outline with round ends that
 * starts fine at its uphill end and swells to full width, like a brush stroke.
 */
function trailShape(line, width, taper) {
  // Draw from the top of the page (uphill) down.
  const pts = resample(line[0][1] <= line[line.length - 1][1] ? line : line.slice().reverse(), 0.2);
  const total = polylineLength(pts);
  const taperLen = Math.min(total * 0.3, 4);
  let s = 0;
  const hw = pts.map((p, i) => {
    if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    return (width / 2) * (taper ? 0.35 + 0.65 * smoothstep(0, taperLen, s) : 1);
  });
  const outline = strokeOutline(pts, hw);
  return simplify([...outline, outline[0]], 0.008);
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
  const bold = o.trailStyle !== 'line';
  const width = Math.max(0.1, o.trailWidth);
  const minTrail = bold ? Math.max(1.2, width * 3) : 0.8;

  // Trails first (they decide where terrain is knocked out), drawn last.
  const trails = [];
  const highlightLines = [];
  for (const trail of scene.trails) {
    const lines = cleanup(map(trail.lines), region, minTrail);
    if (!lines.length) continue;
    if (o.highlight && trail.name && trail.name === o.highlight) highlightLines.push(...lines);
    else trails.push({ trail, lines });
  }
  const allTrailLines = [...trails.flatMap((t) => t.lines), ...highlightLines];

  if (scene.terrain.length) {
    // Engraved lines need clear space between them or they fuse into a smudge:
    // at this print size, keep only every k-th ridgeline / contour so the gap
    // is at least ~3 line widths.
    let source = scene.terrain;
    if (scene.terrainSpacing > 0) {
      const gapMm = scene.terrainSpacing * s;
      const minGap = Math.max(0.6, o.lineWidth * TERRAIN_WEIGHT * 3);
      const k = Math.max(1, Math.ceil(minGap / gapMm - 1e-9));
      if (k > 1) source = source.filter((l) => (l.level ?? 0) % k === 0);
    }
    let t = cleanup(map(source), region, 0.5);
    if (o.knockout && allTrailLines.length) {
      // Clear space between a trail's edge and the edge of the terrain line.
      const gap = width / 2 + (o.lineWidth * TERRAIN_WEIGHT) / 2 + 0.3;
      const mask = lineMask(allTrailLines, gap + (highlightLines.length ? 0.5 : 0), doc.W, doc.H);
      // Drop the slivers left between closely packed trails.
      t = knockout(t, mask).map((l) => simplify(l, 0.02)).filter((l) => polylineLength(l) >= 1.5);
    }
    doc.stroke('terrain', pathData(t), TERRAIN_WEIGHT);
  }

  if (o.liftStyle !== 'none') {
    for (const lift of scene.lifts) {
      let lines = cleanup(map(lift.lines), region, 0.5);
      if (o.liftStyle === 'dashed') lines = lines.flatMap((l) => dashPolyline(l, 1.1, 0.7));
      doc.stroke('lifts', pathData(lines), 0.9);
    }
  }

  for (const { trail, lines } of trails) {
    const layer = o.layerByDifficulty ? `trails-${difficultyClass(trail.difficulty)}` : 'trails';
    if (bold) doc.fill(layer, pathData(lines.map((l) => trailShape(l, width, o.taper)), 3, true));
    else doc.stroke(layer, smoothPathData(lines), 1, width);
  }

  if (highlightLines.length) {
    if (bold) {
      doc.fill('highlight', pathData(highlightLines.map((l) => trailShape(l, width * 1.15, o.taper)), 3, true));
      // A halo line around the run, clear of the solid stroke.
      const halo = highlightLines.map((l) => {
        const pts = resample(l, 0.25);
        const outline = strokeOutline(pts, pts.map(() => width * 0.575 + 0.3 + o.lineWidth / 2));
        return simplify([...outline, outline[0]], 0.01);
      });
      doc.stroke('highlight', pathData(halo, 3, true));
    } else {
      const w = Math.max(0.35, Math.min(box.w, box.h) * 0.006);
      doc.stroke('highlight', pathData(highlightLines.filter((l) => l.length > 1).map((l) => ribbon(l, w)), 3, true));
    }
    if (o.highlightMarker !== 'none') {
      // Marker sits just above the highest point of the run.
      let top = null;
      for (const l of highlightLines) for (const p of l) if (!top || p[1] < top[1]) top = p;
      const size = Math.max(2.2, Math.min(box.w, box.h) * 0.06);
      const fn = o.highlightMarker === 'heart' ? icons.heart : icons.star;
      // Keep the marker inside the art box (it would otherwise hit borders).
      const mx = Math.max(box.x + size / 2, Math.min(box.x + box.w - size / 2, top[0]));
      const my = Math.max(box.y + size / 2, top[1] - size * 0.85);
      doc.fill('text', fn(mx, my, size));
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
