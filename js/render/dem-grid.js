// Regular elevation grid in local metres. Point (i, j) sits at
// (x0 + i * cell, y0 + j * cell); y grows northwards.

export class DemGrid {
  constructor({ nx, ny, x0, y0, cell, data }) {
    this.nx = nx;
    this.ny = ny;
    this.x0 = x0;
    this.y0 = y0;
    this.cell = cell;
    this.data = data;
    let min = Infinity;
    let max = -Infinity;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.min = min;
    this.max = max;
  }

  /** Bilinear sample, clamped to the grid edge. */
  sample(x, y) {
    const { nx, ny, data } = this;
    let fi = (x - this.x0) / this.cell;
    let fj = (y - this.y0) / this.cell;
    fi = fi < 0 ? 0 : fi > nx - 1.001 ? nx - 1.001 : fi;
    fj = fj < 0 ? 0 : fj > ny - 1.001 ? ny - 1.001 : fj;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tx = fi - i;
    const ty = fj - j;
    const k = j * nx + i;
    const a = data[k];
    const b = data[k + 1];
    const c = data[k + nx];
    const d = data[k + nx + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  contains(x, y) {
    return (
      x >= this.x0 && y >= this.y0 &&
      x <= this.x0 + (this.nx - 1) * this.cell && y <= this.y0 + (this.ny - 1) * this.cell
    );
  }
}
