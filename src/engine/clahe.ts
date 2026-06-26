/**
 * CLAHE — Contrast-Limited Adaptive Histogram Equalization.
 *
 * Global tone curves (LUT / gamma / window) can't add *local* contrast: in a
 * dental pano the trabecular bone and tooth structure have low local contrast,
 * so a point operation just shifts the haze around. CLAHE fixes that — it
 * equalizes contrast within local tiles, clipping each tile's histogram so it
 * doesn't blow up noise, then bilinearly blends tile mappings to avoid blocky
 * seams. It's the single biggest visual win for this kind of image.
 *
 * Split of labor:
 *   • The histogram + clip + CDF per tile is cheap and inherently sequential —
 *     computed here on the CPU (in the worker for Babylon), producing one small
 *     mapping curve per tile (`maps`, row-major tile order, `bins` entries each,
 *     normalized 0..1).
 *   • The per-pixel bilinear tile interpolation + lookup is the expensive part —
 *     done per-pixel by the GPU shader (Babylon) or the CPU loop. `sampleClahe`
 *     below is the reference implementation both must match.
 *
 * Input intensities are the *windowed* values in [0,1] (same as the rest of the
 * pipeline), so CLAHE composes cleanly with auto-windowing.
 */

export const CLAHE_TILES = 8; // 8 x 8 grid
export const CLAHE_BINS = 256;

export interface ClaheMaps {
  tilesX: number;
  tilesY: number;
  bins: number;
  /** length = tilesX*tilesY*bins, normalized 0..1, row-major by tile. */
  maps: Float32Array;
}

/**
 * Build per-tile CDF mappings from raw data + the active window.
 *
 * @param clipFactor clip limit as a multiple of the tile's average bin height
 *                   (≈1 = strong clipping/near-linear, larger = more aggressive
 *                   equalization). Typical 2..4.
 */
export function computeClaheMaps(
  data: Float32Array,
  w: number,
  h: number,
  winLow: number,
  winWidth: number,
  clipFactor: number,
  tiles = CLAHE_TILES,
  bins = CLAHE_BINS
): ClaheMaps {
  const tilesX = tiles;
  const tilesY = tiles;
  const tileW = w / tilesX;
  const tileH = h / tilesY;
  const maps = new Float32Array(tilesX * tilesY * bins);
  const invWidth = 1 / (winWidth || 1);
  const binScale = bins - 1;

  const hist = new Uint32Array(bins);

  for (let ty = 0; ty < tilesY; ty++) {
    const y0 = Math.floor(ty * tileH);
    const y1 = ty === tilesY - 1 ? h : Math.floor((ty + 1) * tileH);
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor(tx * tileW);
      const x1 = tx === tilesX - 1 ? w : Math.floor((tx + 1) * tileW);

      hist.fill(0);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          let v = (data[row + x] - winLow) * invWidth;
          if (v < 0) v = 0;
          else if (v > 1) v = 1;
          hist[(v * binScale) | 0]++;
          count++;
        }
      }
      if (count === 0) {
        // Degenerate tile — identity map.
        const base = (ty * tilesX + tx) * bins;
        for (let i = 0; i < bins; i++) maps[base + i] = i / binScale;
        continue;
      }

      // Clip the histogram and redistribute the clipped mass uniformly.
      const avg = count / bins;
      const clip = Math.max(1, clipFactor * avg);
      let excess = 0;
      for (let i = 0; i < bins; i++) {
        if (hist[i] > clip) {
          excess += hist[i] - clip;
          hist[i] = clip;
        }
      }
      const give = excess / bins;

      // CDF → normalized mapping curve for this tile.
      const base = (ty * tilesX + tx) * bins;
      let cum = 0;
      const norm = 1 / count;
      for (let i = 0; i < bins; i++) {
        cum += hist[i] + give;
        maps[base + i] = Math.min(1, cum * norm);
      }
    }
  }

  return { tilesX, tilesY, bins, maps };
}

/** Linear lookup of value `v` (0..1) in one tile's mapping curve. */
function mapTile(m: ClaheMaps, tx: number, ty: number, v: number): number {
  const bins = m.bins;
  const base = (ty * m.tilesX + tx) * bins;
  const x = v * (bins - 1);
  let i0 = x | 0;
  if (i0 < 0) i0 = 0;
  else if (i0 > bins - 1) i0 = bins - 1;
  const i1 = i0 + 1 < bins ? i0 + 1 : i0;
  const f = x - i0;
  return m.maps[base + i0] + (m.maps[base + i1] - m.maps[base + i0]) * f;
}

/**
 * Reference per-pixel CLAHE application: bilinearly interpolate the mappings of
 * the four tiles whose centers surround pixel (x,y), so tile boundaries don't
 * show as seams. `v` is the windowed intensity. The GLSL shader mirrors this.
 */
export function sampleClahe(
  m: ClaheMaps,
  w: number,
  h: number,
  x: number,
  y: number,
  v: number
): number {
  const tileW = w / m.tilesX;
  const tileH = h / m.tilesY;
  // Tile-center coordinates: center of tile t sits at (t+0.5)*tile, so
  // subtracting 0.5 puts pixel coords on the same axis as integer tile indices.
  const fx = x / tileW - 0.5;
  const fy = y / tileH - 0.5;

  let tx0 = Math.floor(fx);
  let ty0 = Math.floor(fy);
  const wx = fx - tx0;
  const wy = fy - ty0;
  let tx1 = tx0 + 1;
  let ty1 = ty0 + 1;

  const cx = (t: number) => (t < 0 ? 0 : t > m.tilesX - 1 ? m.tilesX - 1 : t);
  const cy = (t: number) => (t < 0 ? 0 : t > m.tilesY - 1 ? m.tilesY - 1 : t);
  tx0 = cx(tx0);
  tx1 = cx(tx1);
  ty0 = cy(ty0);
  ty1 = cy(ty1);

  const a = mapTile(m, tx0, ty0, v);
  const b = mapTile(m, tx1, ty0, v);
  const c = mapTile(m, tx0, ty1, v);
  const d = mapTile(m, tx1, ty1, v);
  const top = a + (b - a) * wx;
  const bot = c + (d - c) * wx;
  return top + (bot - top) * wy;
}
