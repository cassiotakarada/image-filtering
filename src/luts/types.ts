/**
 * A 1-D grayscale Look-Up Table (tone curve).
 *
 * Maps a *processed display intensity* in [0,1] → an output intensity in [0,1].
 * The filter pipeline applies it AFTER windowing / denoise / sharpen / gamma,
 * so a LUT is the place a validated "bone vs tissue" tone curve lives: it can
 * compress bright bone and lift dark soft tissue in one pointwise lookup.
 *
 * `values` is the curve sampled at `size` evenly-spaced inputs (0 → size-1),
 * already normalized to [0,1]. Both engines interpolate linearly between
 * entries, so a modest `size` (we standardize on 1024) is plenty smooth.
 *
 * NOTE: these tables are meant to hold *externally validated* curves. The
 * built-ins shipped here are demo approximations — drop real LUTs in via the
 * loader (`loadLut`) to replace them.
 */
export interface Lut {
  /** Stable id used to select the LUT from FilterParams.lut. */
  id: string;
  /** Human label for the dropdown / preset UI. */
  name: string;
  /** Number of entries in `values` (we standardize on STD_LUT_SIZE). */
  size: number;
  /** Curve samples, normalized 0..1, length === size. */
  values: Float32Array;
}

/** Standard table length every LUT is resampled to. */
export const STD_LUT_SIZE = 1024;

/** The "no LUT" sentinel id used by FilterParams.lut. */
export const LUT_NONE = "none";
