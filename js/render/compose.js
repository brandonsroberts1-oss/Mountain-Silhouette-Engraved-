// Assemble a full design document from a template, scene and content.

import { Doc, placeArt } from './art.js';
import { renderTemplate, blankOutline } from './templates.js';

/** Default engraved width (mm) of terrain, lift and frame lines. */
export const DEFAULT_LINE_WIDTH = 0.25;

export function composeDesign({ template, W, H, scene, content, fonts, options, artOptions = {} }) {
  const lineWidth = Math.max(0.1, options.lineWidth ?? DEFAULT_LINE_WIDTH);
  const doc = new Doc(W, H);
  const art = (d, box, region) => (scene ? placeArt(d, scene, box, region, { ...artOptions, lineWidth }) : null);
  renderTemplate(template, doc, content, fonts, options, art);
  doc.cut = doc.cutShape || blankOutline(template, W, H, options.cornerRadius);
  // Every line gets a real engraved width.
  for (const it of doc.items) {
    if (it.kind === 'stroke' && it.width == null) it.width = lineWidth * (it.weight || 1);
  }
  return doc;
}
