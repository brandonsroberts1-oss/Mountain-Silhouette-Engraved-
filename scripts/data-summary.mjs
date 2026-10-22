// Print a short summary of a built data/ folder: source, size and how a few
// well-known resorts came out. Used as a sanity check in the pages workflow.
//
//   node scripts/data-summary.mjs _data "Jackson Hole,Mount Snow"

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'data';
const names = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const at = Object.fromEntries(meta.fields.map((f, i) => [f, i]));
console.log(`${meta.areas.length} ski areas from ${meta.sourceName || 'OpenSkiMap'}, built ${meta.built}`);
const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
for (const q of names) {
  const hits = meta.areas.filter((a) => norm(a[at.name]).includes(norm(q))).slice(0, 3);
  if (!hits.length) console.log(`  ${q}: not found`);
  for (const a of hits) {
    const place = [a[at.region], a[at.cc]].filter(Boolean).join(', ') || 'no place';
    console.log(`  ${q}: "${a[at.name]}" (${place}) ${a[at.runs]} runs, ${a[at.lifts]} lifts`);
  }
}
