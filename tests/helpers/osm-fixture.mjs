// Test helper: an OpenSnowMap-style planet_pistes.osm(.gz) built from the
// synthetic fixture, plus a tiny Natural Earth-style admin-1 file.
//
// Ski areas in it:
//   Test Peak       named landuse=winter_sports way around the fixture's runs/lifts
//   Zürs am Arlberg site=piste relation with a member run and lift, no outline
//   Split Mountain  landuse=winter_sports multipolygon from two half-ring ways
//   Duplicate Peak  site relation plus a same-named outline it doesn't list (one area)
//   Niseko Grand Hirafu  site relation named in Japanese, with name:en
// and things to leave out: an unnamed outline, a nordic piste, a magic carpet,
// an abandoned chair.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function writeOsmPistesFixture(dir, fixture, { gzip = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const nodes = [];
  const ways = [];
  const rels = [];
  let nextNode = 1000;
  let nextWay = 5000;
  const node = ([lon, lat]) => {
    nodes.push({ id: ++nextNode, lon, lat });
    return nextNode;
  };
  const way = (coords, tags, { closed = false } = {}) => {
    const refs = coords.map(node);
    if (closed) refs.push(refs[0]);
    ways.push({ id: ++nextWay, refs, tags });
    return nextWay;
  };
  const box = ([x, y], r) => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];

  // Test Peak: outline, runs (the first two only as route relations), lifts.
  const [cx, cy] = fixture.area.center;
  way(box([cx, cy], 0.03), { landuse: 'winter_sports', name: fixture.area.name }, { closed: true });
  fixture.features.runs.forEach((r, i) => {
    const name = i === 2 ? "Bear's Den & Glades" : r.name;
    if (i < 2) {
      const id = way(r.coords, {});
      rels.push({ members: [['way', id, '']], tags: { type: 'route', route: 'piste', 'piste:type': 'downhill', name, 'piste:difficulty': r.difficulty } });
    } else if (i === 3) {
      // Difficulty only on the route relation.
      const id = way(r.coords, { 'piste:type': 'downhill', name });
      rels.push({ members: [['way', id, '']], tags: { type: 'route', route: 'piste', 'piste:type': 'downhill', 'piste:difficulty': r.difficulty } });
    } else {
      way(r.coords, { 'piste:type': 'downhill', name, 'piste:difficulty': r.difficulty });
    }
  });
  for (const l of fixture.features.lifts) way(l.coords, { aerialway: 'chair_lift', name: l.name });
  way(fixture.features.lifts[0].coords, { aerialway: 'magic_carpet', name: 'Carpet' });
  way(fixture.features.lifts[0].coords, { aerialway: 'chair_lift', name: 'Old chair', abandoned: 'yes' });
  way(fixture.features.runs[0].coords, { 'piste:type': 'nordic', name: 'Loipe' });

  // Zürs: site relation only.
  const madloch = way([[10.16, 47.17], [10.17, 47.16], [10.18, 47.15]], { 'piste:type': 'downhill', name: 'Madloch', 'piste:difficulty': 'expert' });
  const zlift = way([[10.18, 47.15], [10.16, 47.17]], { aerialway: 'chair_lift', name: 'Seekopf' });
  rels.push({ members: [['way', madloch, ''], ['way', zlift, '']], tags: { type: 'site', site: 'piste', name: 'Zürs am Arlberg', website: 'https://example.at' } });

  // Split Mountain: multipolygon outline from two halves.
  const [sx, sy] = [11.5, 46.5];
  const top = way([[sx - 0.02, sy], [sx - 0.02, sy + 0.02], [sx + 0.02, sy + 0.02], [sx + 0.02, sy]], {});
  const bottom = way([[sx + 0.02, sy], [sx + 0.02, sy - 0.02], [sx - 0.02, sy - 0.02], [sx - 0.02, sy]], {});
  // The halves must share their end nodes.
  ways.find((w) => w.id === bottom).refs[0] = ways.find((w) => w.id === top).refs.at(-1);
  ways.find((w) => w.id === bottom).refs[3] = ways.find((w) => w.id === top).refs[0];
  rels.push({ members: [['way', top, 'outer'], ['way', bottom, 'outer']], tags: { type: 'multipolygon', landuse: 'winter_sports', name: 'Split Mountain' } });
  way([[sx - 0.01, sy + 0.01], [sx + 0.01, sy - 0.01]], { 'piste:type': 'downhill', name: 'Split Run', 'piste:difficulty': 'intermediate' });

  // Unnamed outline with a run: no area.
  way(box([12.5, 46.5], 0.01), { landuse: 'winter_sports' }, { closed: true });
  way([[12.499, 46.501], [12.501, 46.499]], { 'piste:type': 'downhill', name: 'Orphan' });

  // Duplicate Peak: a site with a member run, and a same-named outline around another run.
  const [dx, dy] = [7.0, 46.0];
  const dupRun = way([[dx, dy], [dx + 0.005, dy - 0.005]], { 'piste:type': 'downhill', name: 'Dup One' });
  rels.push({ members: [['way', dupRun, '']], tags: { type: 'site', site: 'piste', name: 'Duplicate Peak' } });
  way(box([dx + 0.01, dy], 0.01), { landuse: 'winter_sports', name: 'Duplicate Peak' }, { closed: true });
  way([[dx + 0.008, dy + 0.002], [dx + 0.012, dy - 0.002]], { 'piste:type': 'downhill', name: 'Dup Two' });

  // Niseko: Japanese names with English ones alongside.
  const hirafu = way([[140.68, 42.86], [140.69, 42.85]], { 'piste:type': 'downhill', name: 'ジャンボ', 'name:en': 'Jumbo', 'piste:difficulty': 'easy' });
  rels.push({ members: [['way', hirafu, '']], tags: { type: 'site', site: 'piste', name: 'ニセコ東急 グラン・ヒラフ', 'name:en': 'Niseko Grand Hirafu' } });

  // A tagged node (with child elements), as in the real extract.
  const cannon = ++nextNode;
  const lines = [`<?xml version='1.0' encoding='UTF-8'?>`, `<osm version="0.6" generator="osmium/1.16.0">`, `  <bounds minlat="-90" minlon="-180" maxlat="90" maxlon="180"/>`];
  for (const n of nodes) lines.push(`  <node id="${n.id}" version="3" timestamp="2026-01-01T00:00:00Z" uid="7" user="a&amp;b" changeset="9" lat="${n.lat.toFixed(7)}" lon="${n.lon.toFixed(7)}"/>`);
  lines.push(`  <node id="${cannon}" version="1" lat="42.9" lon="-72.9">`, `    <tag k="man_made" v="snow_cannon"/>`, `  </node>`);
  for (const w of ways) {
    lines.push(`  <way id="${w.id}" version="2">`);
    for (const r of w.refs) lines.push(`    <nd ref="${r}"/>`);
    for (const [k, v] of Object.entries(w.tags)) lines.push(`    <tag k="${esc(k)}" v="${esc(v)}"/>`);
    lines.push('  </way>');
  }
  rels.forEach((r, i) => {
    lines.push(`  <relation id="${9000 + i}" version="1">`);
    for (const [type, ref, role] of r.members) lines.push(`    <member type="${type}" ref="${ref}" role="${role}"/>`);
    for (const [k, v] of Object.entries(r.tags)) lines.push(`    <tag k="${esc(k)}" v="${esc(v)}"/>`);
    lines.push('  </relation>');
  });
  lines.push('</osm>', '');
  const xml = lines.join('\n');
  const file = path.join(dir, gzip ? 'planet_pistes.osm.gz' : 'planet_pistes.osm');
  fs.writeFileSync(file, gzip ? zlib.gzipSync(xml) : xml);

  const square = ([x, y], r) => [[[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r]]];
  const admin = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'Vermont', admin: 'United States of America', iso_a2: 'US', iso_3166_2: 'US-VT' }, geometry: { type: 'Polygon', coordinates: square([cx, cy], 1) } },
      {
        type: 'Feature',
        properties: { name: 'Vorarlberg', admin: 'Austria', iso_a2: 'AT', iso_3166_2: 'AT-8' },
        geometry: { type: 'MultiPolygon', coordinates: [[...square([10.17, 47.16], 0.5), square([10.4, 47.4], 0.05)[0]]] },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'admin1.geojson'), JSON.stringify(admin));
  return { file, rels };
}
