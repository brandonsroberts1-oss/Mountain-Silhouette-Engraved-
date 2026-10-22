// Reader for OpenSnowMap's planet_pistes.osm.gz (https://www.opensnowmap.org/download/):
// a daily OpenStreetMap XML extract of every piste, lift, ski-area outline
// (landuse=winter_sports) and ski-area relation (site=piste), with the nodes
// they use. Used when OpenSkiMap's downloads are unavailable.
//
// Ski areas are site=piste relations and named landuse=winter_sports areas.
// A run or lift belongs to an area when it's a member of the area's relation
// or has a point inside one of its outlines.

import zlib from 'node:zlib';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { norm, r5, packLine, bboxCenter, readStream } from './common.mjs';
import { pointInRing } from '../../js/data/geo.js';

export const SOURCE = {
  name: 'OpenSnowMap',
  url: 'https://www.opensnowmap.org',
  attribution: 'Data © OpenStreetMap contributors (ODbL), extract courtesy of opensnowmap.org; regions from Natural Earth',
  license:
    'This directory contains data derived from the OpenStreetMap piste extract published by OpenSnowMap\n' +
    '(https://www.opensnowmap.org, courtesy of opensnowmap.org). Region names: Natural Earth (public domain).\n\n',
};

export const DEFAULT_URL = 'https://www.opensnowmap.org/download/planet_pistes.osm.gz';

const LIFTS = new Set(['chair_lift', 'gondola', 'cable_car', 'mixed_lift', 'drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow']);
const dead = (t) => t.abandoned === 'yes' || t.disused === 'yes' || t['piste:abandoned'] === 'yes';
// piste:type can list several uses, e.g. "downhill;skitour".
const downhill = (t) => !!t['piste:type'] && t['piste:type'].split(';').some((v) => v.trim() === 'downhill');

// ---------------------------------------------------------------------------
// Node coordinates, kept in typed arrays (tens of millions of nodes) and
// looked up by binary search. OSM files list nodes sorted by id.

class NodeStore {
  constructor() {
    this.n = 0;
    this.ids = new Float64Array(1 << 16);
    this.lon = new Int32Array(1 << 16);
    this.lat = new Int32Array(1 << 16);
    this.sorted = true;
  }

  add(id, lon, lat) {
    if (this.n === this.ids.length) {
      const grow = (a) => {
        const b = new a.constructor(a.length * 2);
        b.set(a);
        return b;
      };
      this.ids = grow(this.ids);
      this.lon = grow(this.lon);
      this.lat = grow(this.lat);
    }
    if (this.n && id <= this.ids[this.n - 1]) this.sorted = false;
    this.ids[this.n] = id;
    this.lon[this.n] = Math.round(lon * 1e7);
    this.lat[this.n] = Math.round(lat * 1e7);
    this.n++;
  }

  /** Called once all nodes are in. */
  seal() {
    if (this.sorted) return;
    const order = Array.from({ length: this.n }, (_, i) => i).sort((a, b) => this.ids[a] - this.ids[b]);
    const pick = (a) => Float64Array.from(order, (i) => a[i]);
    this.ids = pick(this.ids);
    this.lon = Int32Array.from(order, (i) => this.lon[i]);
    this.lat = Int32Array.from(order, (i) => this.lat[i]);
    this.sorted = true;
  }

  get(id) {
    let lo = 0;
    let hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.ids[mid];
      if (v === id) return [this.lon[mid] / 1e7, this.lat[mid] / 1e7];
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming OSM XML reader. Elements are matched one tag at a time; a partial
// tag at the end of a chunk is carried over to the next one.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) =>
  s.includes('&')
    ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
        e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m
      )
    : s;

function attr(attrs, name) {
  const key = ` ${name}="`;
  const i = attrs.indexOf(key);
  if (i < 0) return null;
  const s = i + key.length;
  return attrs.slice(s, attrs.indexOf('"', s));
}

async function readOsm(file, { onNode, onWay, onRelation }) {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  let input = readStream(file);
  // Gzipped unless the server already decompressed it in transit.
  if (head[0] === 0x1f && head[1] === 0x8b) input = input.pipe(zlib.createGunzip());

  const re = /<(\/?)(node|way|relation|nd|tag|member)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g;
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let cur = null;
  for await (const chunk of input) {
    const text = carry + decoder.write(chunk);
    re.lastIndex = 0;
    let end = 0;
    let m;
    while ((m = re.exec(text))) {
      end = re.lastIndex;
      const [, close, name, raw, selfClose] = m;
      const attrs = /[\t\n\r]/.test(raw) ? raw.replace(/\s+/g, ' ') : raw;
      if (name === 'nd') {
        if (cur) cur.refs.push(Number(attr(attrs, 'ref')));
      } else if (name === 'tag') {
        if (cur) cur.tags[unescape(attr(attrs, 'k') || '')] = unescape(attr(attrs, 'v') || '');
      } else if (name === 'member') {
        if (cur) cur.members.push({ type: attr(attrs, 'type'), ref: Number(attr(attrs, 'ref')), role: unescape(attr(attrs, 'role') || '') });
      } else if (name === 'node') {
        if (!close) onNode(Number(attr(attrs, 'id')), Number(attr(attrs, 'lon')), Number(attr(attrs, 'lat')));
      } else if (close) {
        if (cur) (cur.type === 'way' ? onWay : onRelation)(cur);
        cur = null;
      } else {
        cur = { type: name, id: Number(attr(attrs, 'id')), refs: [], tags: {}, members: [] };
        if (selfClose) {
          (name === 'way' ? onWay : onRelation)(cur);
          cur = null;
        }
      }
    }
    // '<' is always escaped inside attribute values, so the last '<' starts the last (maybe partial) tag.
    carry = text.slice(Math.max(end, text.lastIndexOf('<')));
  }
}

// ---------------------------------------------------------------------------

/** Join way segments end to end into closed rings. */
function assembleRings(segments) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const closed = (r) => r.length >= 4 && same(r[0], r[r.length - 1]);
  const pool = segments.filter((s) => s.length >= 2);
  const out = [];
  while (pool.length) {
    let ring = pool.pop();
    while (!closed(ring)) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((s) => same(s[0], end) || same(s[s.length - 1], end));
      if (i < 0) break;
      const s = pool.splice(i, 1)[0];
      ring = ring.concat((same(s[0], end) ? s : s.slice().reverse()).slice(1));
    }
    if (closed(ring)) out.push(ring);
  }
  return out;
}

function bboxOf(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) {
    for (const [x, y] of r) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b;
}

/** Spatial grid over polygon bounding boxes (cell size in degrees). */
function polygonGrid(polys, cell = 0.25) {
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const p of polys) {
    const [x0, y0, x1, y1] = p.bbox;
    for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) {
      for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
      }
    }
  }
  return ([x, y]) =>
    (grid.get(key(x, y)) || []).filter((p) => x >= p.bbox[0] && x <= p.bbox[2] && y >= p.bbox[1] && y <= p.bbox[3] && p.rings.some((r) => pointInRing([x, y], r)));
}

/** A few points along a line: enough to tell which outline it lies in. */
const samples = (c) => (c.length <= 5 ? c : [0, 0.25, 0.5, 0.75, 1].map((f) => c[Math.round(f * (c.length - 1))]));

/** Returns { areas, buckets } in the same shape as readOpenSkiMap. */
export async function readOpenSnowMap(file, { only = null } = {}) {
  const t0 = Date.now();
  const nodes = new NodeStore();
  const pistes = new Map(); // way id -> { name, difficulty, area, c }
  const lifts = new Map(); // way id -> { name, type, c }
  const ways = new Map(); // way id -> raw coords, for outlines and route members
  const polys = []; // { key, name, rings }
  const sites = [];
  const multipolygons = [];
  const routes = [];
  let sealed = false;

  await readOsm(file, {
    onNode(id, lon, lat) {
      if (sealed) throw new Error('OSM file is not sorted (node after ways)');
      if (Number.isFinite(lon) && Number.isFinite(lat)) nodes.add(id, lon, lat);
    },
    onWay(w) {
      if (!sealed) {
        nodes.seal();
        sealed = true;
        console.log(`nodes: ${nodes.n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      const t = w.tags;
      if (dead(t)) return;
      const coords = [];
      for (const ref of w.refs) {
        const p = nodes.get(ref);
        if (p) coords.push(p);
      }
      if (coords.length < 2) return;
      const closed = w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];
      if (downhill(t)) {
        pistes.set(w.id, { name: t['piste:name'] || t.name || null, difficulty: t['piste:difficulty'] || null, area: closed || t.area === 'yes', c: packLine(coords) });
      } else if (LIFTS.has(t.aerialway)) {
        lifts.set(w.id, { name: t.name || null, type: t.aerialway, c: packLine(coords) });
      } else {
        // Outlines and untagged route members; resolved once relations are in.
        ways.set(w.id, coords);
        if (t.landuse === 'winter_sports' && closed) polys.push({ key: `w${w.id}`, name: t.name || null, rings: [coords] });
      }
    },
    onRelation(r) {
      const t = r.tags;
      if (dead(t)) return;
      if (t.site === 'piste') sites.push({ id: r.id, name: t.name || null, web: t.website || '', members: r.members });
      else if (t.landuse === 'winter_sports') multipolygons.push({ id: r.id, name: t.name || null, outer: r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref) });
      else if (downhill(t)) routes.push({ name: t['piste:name'] || t.name || null, difficulty: t['piste:difficulty'] || null, ways: r.members.filter((m) => m.type === 'way').map((m) => m.ref) });
    },
  });
  console.log(`pistes: ${pistes.size}, lifts: ${lifts.size}, sites: ${sites.length}, outlines: ${polys.length + multipolygons.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // Route relations name their member ways, and some runs exist only as routes.
  for (const r of routes) {
    for (const id of r.ways) {
      const p = pistes.get(id);
      if (p) {
        p.name = p.name || r.name;
        p.difficulty = p.difficulty || r.difficulty;
      } else if (ways.has(id)) {
        pistes.set(id, { name: r.name, difficulty: r.difficulty, area: false, c: packLine(ways.get(id)) });
      }
    }
  }
  for (const mp of multipolygons) {
    const rings = assembleRings(mp.outer.map((id) => ways.get(id)).filter(Boolean));
    if (rings.length) polys.push({ key: `r${mp.id}`, name: mp.name, rings });
  }
  for (const p of polys) p.bbox = bboxOf(p.rings);
  const polyByKey = new Map(polys.map((p) => [p.key, p]));

  // Ski areas: site relations first (they own the outlines they include), then
  // named outlines that no site claims.
  const entries = new Map();
  const owner = new Map(); // outline key -> area id
  for (const s of sites) {
    if (!s.name) continue;
    const e = { id: `osm-r${s.id}`, name: s.name, web: s.web, runs: new Set(), lifts: new Set(), outlines: [] };
    for (const m of s.members) {
      if (m.type === 'way' && pistes.has(m.ref)) e.runs.add(m.ref);
      else if (m.type === 'way' && lifts.has(m.ref)) e.lifts.add(m.ref);
      const key = `${m.type === 'way' ? 'w' : 'r'}${m.ref}`;
      if ((m.type === 'way' || m.type === 'relation') && polyByKey.has(key)) e.outlines.push(polyByKey.get(key));
    }
    for (const p of e.outlines) if (!owner.has(p.key)) owner.set(p.key, e.id);
    entries.set(e.id, e);
  }
  // An outline named like a nearby site that doesn't list it is that site's too.
  const siteBoxes = [...entries.values()].map((e) => {
    const parts = [...[...e.runs].map((id) => pistes.get(id).c), ...[...e.lifts].map((id) => lifts.get(id).c), ...e.outlines.flatMap((p) => p.rings)];
    return { e, key: norm(e.name), bbox: parts.length ? bboxOf(parts) : null };
  });
  const near = (a, b) => a && a[0] - 0.02 <= b[2] && b[0] - 0.02 <= a[2] && a[1] - 0.02 <= b[3] && b[1] - 0.02 <= a[3];
  for (const p of polys) {
    if (owner.has(p.key) || !p.name) continue;
    const site = siteBoxes.find((s) => s.key === norm(p.name) && near(s.bbox, p.bbox));
    if (site) {
      site.e.outlines.push(p);
      owner.set(p.key, site.e.id);
      continue;
    }
    const e = { id: `osm-${p.key}`, name: p.name, web: '', runs: new Set(), lifts: new Set(), outlines: [p] };
    owner.set(p.key, e.id);
    entries.set(e.id, e);
  }

  const inside = polygonGrid(polys.filter((p) => owner.has(p.key)));
  const assign = (map, field) => {
    for (const [id, f] of map) {
      const ids = new Set();
      for (const pt of samples(f.c)) for (const p of inside(pt)) ids.add(owner.get(p.key));
      for (const a of ids) entries.get(a)[field].add(id);
    }
  };
  assign(pistes, 'runs');
  assign(lifts, 'lifts');

  const areas = new Map();
  const buckets = new Map();
  for (const e of entries.values()) {
    if (only && !only.some((q) => norm(e.name).includes(q))) continue;
    const runs = [];
    const areaRuns = [];
    const lf = [];
    for (const id of e.runs) {
      const p = pistes.get(id);
      (p.area ? areaRuns : runs).push(JSON.stringify({ n: p.name, d: p.difficulty, c: p.c }));
    }
    for (const id of e.lifts) {
      const l = lifts.get(id);
      lf.push(JSON.stringify({ n: l.name, t: l.type, c: l.c }));
    }
    if (!runs.length && !areaRuns.length) continue;
    const c = e.outlines.length ? bboxCenter(e.outlines.flatMap((p) => p.rings)) : bboxCenter([...e.runs].map((id) => pistes.get(id).c));
    areas.set(e.id, { id: e.id, name: e.name, lon: r5(c[0]), lat: r5(c[1]), locality: '', region: '', country: '', cc: '', conv: '', minE: null, maxE: null, web: e.web });
    buckets.set(e.id, { runs, areaRuns, lifts: lf });
  }
  console.log(`ski areas with runs: ${areas.size} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { areas, buckets };
}
