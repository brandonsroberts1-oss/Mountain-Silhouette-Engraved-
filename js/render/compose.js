// Assemble a full design document from a template, scene and content.

import { Doc, placeArt } from './art.js';
import { renderTemplate, blankOutline } from './templates.js';

export function composeDesign({ template, W, H, scene, content, fonts, options, artOptions }) {
  const doc = new Doc(W, H);
  const art = (d, box, region) => (scene ? placeArt(d, scene, box, region, artOptions) : null);
  renderTemplate(template, doc, content, fonts, options, art);
  doc.cut = doc.cutShape || blankOutline(template, W, H, options.cornerRadius);
  return doc;
}
