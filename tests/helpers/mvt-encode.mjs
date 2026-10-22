// Test helper: encode features as a Mapbox Vector Tile (MVT 2.x), to exercise
// the app's decoder and the OpenSkiMap-tiles data path without the network.

function varint(n, out) {
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
const key = (field, wire, out) => varint(field * 8 + wire, out);
const zz = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

function lenField(field, bytes, out) {
  key(field, 2, out);
  varint(bytes.length, out);
  for (const b of bytes) out.push(b);
}

function packed(field, nums, out) {
  const body = [];
  for (const n of nums) varint(n, body);
  lenField(field, body, out);
}

function encodeValue(v) {
  const out = [];
  if (typeof v === 'string') lenField(1, [...new TextEncoder().encode(v)], out);
  else if (typeof v === 'boolean') {
    key(7, 0, out);
    varint(v ? 1 : 0, out);
  } else if (Number.isInteger(v) && v >= 0) {
    key(5, 0, out);
    varint(v, out);
  } else if (Number.isInteger(v)) {
    key(6, 0, out);
    varint(zz(v), out);
  } else {
    key(3, 1, out);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    out.push(...b);
  }
  return out;
}

function encodeGeometry(type, lines) {
  const cmds = [];
  let x = 0;
  let y = 0;
  for (const raw of lines) {
    const pts = type === 'Polygon' ? raw.slice(0, -1) : raw;
    cmds.push(1 | (1 << 3), zz(pts[0][0] - x), zz(pts[0][1] - y));
    [x, y] = pts[0];
    cmds.push(2 | ((pts.length - 1) << 3));
    for (const p of pts.slice(1)) {
      cmds.push(zz(p[0] - x), zz(p[1] - y));
      [x, y] = p;
    }
    if (type === 'Polygon') cmds.push(7 | (1 << 3));
  }
  return cmds;
}

/** layers: { name: [{ type: 'LineString'|'Polygon', properties, geometry: [[[x,y],...]] }] } */
export function encodeTile(layers, extent = 4096) {
  const tile = [];
  for (const [name, features] of Object.entries(layers)) {
    const keys = [];
    const values = [];
    const kIndex = new Map();
    const vIndex = new Map();
    const layer = [];
    key(15, 0, layer);
    varint(2, layer);
    lenField(1, [...new TextEncoder().encode(name)], layer);
    for (const f of features) {
      const tags = [];
      for (const [k, v] of Object.entries(f.properties)) {
        if (v == null) continue;
        if (!kIndex.has(k)) {
          kIndex.set(k, keys.length);
          keys.push(k);
        }
        const vk = `${typeof v}:${v}`;
        if (!vIndex.has(vk)) {
          vIndex.set(vk, values.length);
          values.push(v);
        }
        tags.push(kIndex.get(k), vIndex.get(vk));
      }
      const feat = [];
      packed(2, tags, feat);
      key(3, 0, feat);
      varint(f.type === 'Polygon' ? 3 : f.type === 'Point' ? 1 : 2, feat);
      packed(4, encodeGeometry(f.type, f.geometry), feat);
      lenField(2, feat, layer);
    }
    for (const k of keys) lenField(3, [...new TextEncoder().encode(k)], layer);
    for (const v of values) lenField(4, encodeValue(v), layer);
    key(5, 0, layer);
    varint(extent, layer);
    lenField(3, layer, tile);
  }
  return new Uint8Array(tile);
}

/** lon/lat → tile pixel coordinates for tile (z, x, y). */
export function project([lon, lat], z, x, y, extent = 4096) {
  const n = 2 ** z;
  const px = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [Math.round((px - x) * extent), Math.round((py - y) * extent)];
}
