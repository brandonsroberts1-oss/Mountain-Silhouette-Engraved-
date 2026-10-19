// Small-area geographic helpers.

const R_EQ = 111320; // metres per degree of longitude at the equator
const M_PER_DEG_LAT = 110574;

/** Equirectangular projection to local metres around (lon0, lat0). */
export function makeProjection(lon0, lat0) {
  const kx = R_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    lon0,
    lat0,
    toLocal: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

export function bboxOfCoords(coordLists) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const list of coordLists) {
    for (const [lon, lat] of list) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function expandBbox(b, frac, minMeters = 0) {
  const latMid = (b.minLat + b.maxLat) / 2;
  const kx = R_EQ * Math.cos((latMid * Math.PI) / 180);
  const dLon = Math.max((b.maxLon - b.minLon) * frac, minMeters / kx);
  const dLat = Math.max((b.maxLat - b.minLat) * frac, minMeters / M_PER_DEG_LAT);
  return { minLon: b.minLon - dLon, minLat: b.minLat - dLat, maxLon: b.maxLon + dLon, maxLat: b.maxLat + dLat };
}

export function bboxAround([lon, lat], meters) {
  const kx = R_EQ * Math.cos((lat * Math.PI) / 180);
  const dLon = meters / kx;
  const dLat = meters / M_PER_DEG_LAT;
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}

export function bboxAreaKm2(b) {
  const latMid = (b.minLat + b.maxLat) / 2;
  const w = (b.maxLon - b.minLon) * R_EQ * Math.cos((latMid * Math.PI) / 180);
  const h = (b.maxLat - b.minLat) * M_PER_DEG_LAT;
  return (w * h) / 1e6;
}

/** Outer rings of a (Multi)Polygon GeoJSON geometry, or [] for anything else. */
export function polygonRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => p[0]);
  return [];
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function geometryCenter(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates.slice(0, 2);
  const rings = polygonRings(geometry);
  if (!rings.length) return null;
  const b = bboxOfCoords(rings);
  return [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2];
}
