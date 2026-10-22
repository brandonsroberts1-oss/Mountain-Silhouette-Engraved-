// Minimal Mapbox Vector Tile (MVT 2.x) decoder: just enough protobuf to read
// layers, feature properties and line/polygon geometry in tile coordinates.

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  varint() {
    let val = 0;
    let mul = 1;
    let b;
    do {
      b = this.buf[this.pos++];
      val += (b & 0x7f) * mul;
      mul *= 128;
    } while (b >= 0x80);
    return val;
  }

  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return this.buf.subarray(start, start + len);
  }

  string() {
    return new TextDecoder().decode(this.bytes());
  }

  float() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  double() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  packed() {
    const end = this.varint() + this.pos;
    const out = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }

  *fields() {
    while (this.pos < this.buf.length) {
      const tag = this.varint();
      yield [tag >> 3, tag & 7];
    }
  }
}

const zigzag = (n) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

function decodeValue(buf) {
  const r = new Reader(buf);
  let value = null;
  for (const [field, wire] of r.fields()) {
    if (field === 1) value = r.string();
    else if (field === 2) value = r.float();
    else if (field === 3) value = r.double();
    else if (field === 4 || field === 5) value = r.varint();
    else if (field === 6) value = zigzag(r.varint());
    else if (field === 7) value = r.varint() === 1;
    else r.skip(wire);
  }
  return value;
}

function decodeGeometry(cmds) {
  const lines = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const ci = cmds[i++];
    const id = ci & 7;
    const count = Math.floor(ci / 8);
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        if (id === 1) lines.push((cur = [[x, y]]));
        else if (cur) cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur && cur.length) cur.push(cur[0].slice());
    } else {
      break;
    }
  }
  return lines;
}

const GEOM_TYPES = { 1: 'Point', 2: 'LineString', 3: 'Polygon' };

function decodeLayer(buf) {
  const r = new Reader(buf);
  const layer = { name: '', extent: 4096, keys: [], values: [], raw: [] };
  for (const [field, wire] of r.fields()) {
    if (field === 1) layer.name = r.string();
    else if (field === 2) layer.raw.push(r.bytes());
    else if (field === 3) layer.keys.push(r.string());
    else if (field === 4) layer.values.push(decodeValue(r.bytes()));
    else if (field === 5) layer.extent = r.varint();
    else r.skip(wire);
  }
  layer.features = layer.raw.map((fb) => {
    const fr = new Reader(fb);
    const f = { type: null, properties: {}, geometry: [] };
    let tags = [];
    let geom = [];
    for (const [field, wire] of fr.fields()) {
      if (field === 2) tags = fr.packed();
      else if (field === 3) f.type = GEOM_TYPES[fr.varint()] || null;
      else if (field === 4) geom = fr.packed();
      else fr.skip(wire);
    }
    for (let t = 0; t + 1 < tags.length; t += 2) f.properties[layer.keys[tags[t]]] = layer.values[tags[t + 1]];
    f.geometry = decodeGeometry(geom);
    return f;
  });
  delete layer.raw;
  return layer;
}

/** Decode a vector tile into { layerName: { extent, features: [...] } }. */
export function decodeTile(bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const layers = {};
  for (const [field, wire] of r.fields()) {
    if (field === 3) {
      const layer = decodeLayer(r.bytes());
      layers[layer.name] = layer;
    } else {
      r.skip(wire);
    }
  }
  return layers;
}

/** Tiles are sometimes served gzipped without a Content-Encoding header. */
export async function maybeGunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b || typeof DecompressionStream === 'undefined') return u8;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
