/**
 * Synthetic phantom generator — 100% procedural, ZERO patient data.
 *
 * Produces a 16-bit (12-bit-range) MONOCHROME2 grayscale image: gradient
 * background, bright discs, a high-contrast bar pattern (a resolution target,
 * good for seeing sharpen/edge effects), and deterministic speckle noise. Fed
 * to Cornerstone via the `source:` custom loader in cornerstoneSetup.ts.
 */

export interface Phantom {
  pixels: Uint16Array;
  width: number;
  height: number;
}

export function makePhantom(size = 512): Phantom {
  const w = size;
  const h = size;
  const px = new Uint16Array(w * h);
  const maxVal = 4095;

  const discs = [
    [w * 0.3, h * 0.35, w * 0.12, maxVal * 0.9],
    [w * 0.65, h * 0.6, w * 0.08, maxVal * 0.75],
    [w * 0.5, h * 0.25, w * 0.05, maxVal * 1.0],
  ];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Diagonal gradient background.
      let v = ((x + y) / (w + h)) * maxVal * 0.6;

      // Bright discs.
      for (const [cx, cy, r, val] of discs) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < r * r) v = val;
      }

      // High-contrast vertical bars (resolution target) on the right.
      if (x > w * 0.78) {
        const period = 6;
        v = Math.floor(x / period) % 2 === 0 ? maxVal * 0.95 : maxVal * 0.1;
      }

      // Deterministic speckle noise.
      const noise = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      v += noise * maxVal * 0.06;

      px[y * w + x] = Math.max(0, Math.min(maxVal, Math.round(v)));
    }
  }

  return { pixels: px, width: w, height: h };
}
