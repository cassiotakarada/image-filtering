/**
 * Intensity-based tissue segmentation for dental images.
 *
 * Density maps to brightness in an X-ray, so the histogram separates (roughly):
 *   air  <  soft tissue  <  bone  <  teeth (dentin/enamel, brightest).
 * Two thresholds (t1 = tissue|bone, t2 = bone|tooth) split the *windowed* [0,1]
 * intensity into three classes. We classify on the windowed value — NOT the
 * CLAHE-equalized one — because CLAHE destroys the global density ordering.
 *
 * Thresholds can be auto-picked with 2-level Otsu (maximize between-class
 * variance) or set by hand. Membership is *soft* (smoothstep transition bands)
 * so class boundaries don't show as hard seams, and a pixel near a boundary
 * blends between the two classes' treatments. The GLSL shader and the CPU engine
 * both implement the identical membership math; this module provides the shared
 * threshold computation + class palette.
 */

export const SEG_BINS = 256;

/** Pseudocolor palette for the class-map view / tint (RGB, 0..1). */
export const SEG_COLORS = {
  tissue: [0.25, 0.45, 0.95] as [number, number, number], // blue
  bone: [0.3, 0.9, 0.45] as [number, number, number], // green
  tooth: [1.0, 0.55, 0.2] as [number, number, number], // orange
};

/** Histogram of windowed [0,1] values (edge-clamped), SEG_BINS bins. */
export function windowedHistogram(
  data: Float32Array,
  winLow: number,
  winWidth: number,
  bins = SEG_BINS
): Uint32Array {
  const hist = new Uint32Array(bins);
  const inv = 1 / (winWidth || 1);
  const scale = bins - 1;
  for (let i = 0; i < data.length; i++) {
    let v = (data[i] - winLow) * inv;
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    hist[(v * scale) | 0]++;
  }
  return hist;
}

/**
 * 2-level Otsu: pick t1 < t2 maximizing inter-class variance over three classes.
 * Returns thresholds normalized to [0,1]. O(bins²) with prefix sums.
 */
export function otsu2(hist: Uint32Array): { t1: number; t2: number } {
  const bins = hist.length;
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return { t1: 1 / 3, t2: 2 / 3 };

  // Prefix sums of weight (w) and weighted intensity (m).
  const w = new Float64Array(bins + 1);
  const m = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) {
    w[i + 1] = w[i] + hist[i];
    m[i + 1] = m[i] + i * hist[i];
  }
  // Class mass/mean between bin indices [a, b).
  const mass = (a: number, b: number) => w[b] - w[a];
  const sum = (a: number, b: number) => m[b] - m[a];

  let best = -1;
  let bt1 = Math.floor(bins / 3);
  let bt2 = Math.floor((2 * bins) / 3);
  for (let i = 1; i < bins - 1; i++) {
    const w0 = mass(0, i);
    if (w0 === 0) continue;
    const m0 = sum(0, i) / w0;
    for (let j = i + 1; j < bins; j++) {
      const w1 = mass(i, j);
      const w2 = mass(j, bins);
      if (w1 === 0 || w2 === 0) continue;
      const m1 = sum(i, j) / w1;
      const m2 = sum(j, bins) / w2;
      const gm = sum(0, bins) / total;
      // Between-class variance (×total²; constant factors don't affect argmax).
      const v =
        w0 * (m0 - gm) * (m0 - gm) +
        w1 * (m1 - gm) * (m1 - gm) +
        w2 * (m2 - gm) * (m2 - gm);
      if (v > best) {
        best = v;
        bt1 = i;
        bt2 = j;
      }
    }
  }
  return { t1: bt1 / (bins - 1), t2: bt2 / (bins - 1) };
}
