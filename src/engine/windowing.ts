/**
 * Auto-windowing — fit the display window to the actual pixel histogram instead
 * of trusting the DICOM default (which often spans the full sensor range, so
 * real tissue/bone detail sits in a tiny slice of [0,1] and looks flat).
 *
 * We take robust percentile bounds (default p0.5..p99.5) so a big black border
 * or a few hot pixels don't dominate. The result is a {center,width} the engine
 * uses as the *base* window; the brightness/contrast sliders still modulate it.
 */
export interface Window {
  center: number;
  width: number;
}

const HIST_BINS = 1024;

export function computeAutoWindow(
  data: Float32Array,
  min: number,
  max: number,
  pLow = 0.005,
  pHigh = 0.995
): Window {
  const span = max - min;
  if (span <= 0) return { center: min, width: 1 };

  const hist = new Uint32Array(HIST_BINS);
  const scale = (HIST_BINS - 1) / span;
  for (let i = 0; i < data.length; i++) {
    let b = ((data[i] - min) * scale) | 0;
    if (b < 0) b = 0;
    else if (b >= HIST_BINS) b = HIST_BINS - 1;
    hist[b]++;
  }

  const total = data.length;
  const loCount = total * pLow;
  const hiCount = total * pHigh;
  let cum = 0;
  let loBin = 0;
  let hiBin = HIST_BINS - 1;
  let haveLo = false;
  for (let b = 0; b < HIST_BINS; b++) {
    cum += hist[b];
    if (!haveLo && cum >= loCount) {
      loBin = b;
      haveLo = true;
    }
    if (cum >= hiCount) {
      hiBin = b;
      break;
    }
  }

  const lo = min + loBin / scale;
  const hi = min + hiBin / scale;
  const width = Math.max(1, hi - lo);
  return { center: lo + width / 2, width };
}
