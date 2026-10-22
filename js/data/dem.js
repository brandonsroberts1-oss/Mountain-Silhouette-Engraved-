// Elevation from the public AWS Terrain Tiles (Terrarium PNG encoding):
// elevation = R * 256 + G + B / 256 - 32768 metres.

import { DemGrid } from '../render/dem-grid.js';
import { fetchWithTimeout } from './net.js';

const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TILE = 256;
const tileCache = new Map();

function lonToX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z * TILE;
}

function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TILE;
}

async function loadTile(z, x, y, signal) {
  const url = TILE_URL(z, x, y);
  if (tileCache.has(url)) return tileCache.get(url);
  const p = (async () => {
    const blob = await fetchWithTimeout(url, { signal, kind: 'terrainTile', parse: 'blob', mode: 'cors' });
    const bmp = await createImageBitmap(blob);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    const elev = new Float32Array(TILE * TILE);
    for (let i = 0; i < elev.length; i++) {
      elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    }
    return elev;
  })();
  tileCache.set(url, p);
  p.catch(() => tileCache.delete(url));
  return p;
}

/**
 * Build a DemGrid covering [-half, half]² local metres around the projection
 * origin, resampled to gridN × gridN.
 */
export async function loadDem(proj, half, { gridN = 360, maxTiles = 20, signal } = {}) {
  const [w, s] = proj.toLonLat([-half, -half]);
  const [e, n] = proj.toLonLat([half, half]);
  let z = 14;
  let tx0, tx1, ty0, ty1;
  for (; z >= 8; z--) {
    tx0 = Math.floor(lonToX(w, z) / TILE);
    tx1 = Math.floor(lonToX(e, z) / TILE);
    ty0 = Math.floor(latToY(n, z) / TILE);
    ty1 = Math.floor(latToY(s, z) / TILE);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) break;
  }
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const mw = cols * TILE;
  const mosaic = new Float32Array(mw * rows * TILE).fill(NaN);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadTile(z, tx, ty, signal).then(
          (elev) => {
            const ox = (tx - tx0) * TILE;
            const oy = (ty - ty0) * TILE;
            for (let r = 0; r < TILE; r++) mosaic.set(elev.subarray(r * TILE, (r + 1) * TILE), (oy + r) * mw + ox);
          },
          (err) => {
            if (err.name === 'AbortError') throw err;
          }
        )
      );
    }
  }
  await Promise.all(jobs);

  const sample = (px, py) => {
    px = Math.max(0, Math.min(mw - 1.001, px));
    py = Math.max(0, Math.min(rows * TILE - 1.001, py));
    const i = Math.floor(px);
    const j = Math.floor(py);
    const fx = px - i;
    const fy = py - j;
    const k = j * mw + i;
    const a = mosaic[k], b = mosaic[k + 1], c = mosaic[k + mw], d = mosaic[k + mw + 1];
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  const cell = (2 * half) / (gridN - 1);
  const data = new Float32Array(gridN * gridN);
  const ox = tx0 * TILE;
  const oy = ty0 * TILE;
  let valid = 0;
  let sum = 0;
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const [lon, lat] = proj.toLonLat([-half + i * cell, -half + j * cell]);
      const v = sample(lonToX(lon, z) - ox, latToY(lat, z) - oy);
      data[j * gridN + i] = v;
      if (Number.isFinite(v)) {
        valid++;
        sum += v;
      }
    }
  }
  if (!valid) throw new Error('Could not load terrain elevation tiles.');
  const fill = sum / valid;
  for (let k = 0; k < data.length; k++) if (!Number.isFinite(data[k])) data[k] = fill;
  return new DemGrid({ nx: gridN, ny: gridN, x0: -half, y0: -half, cell, data });
}
