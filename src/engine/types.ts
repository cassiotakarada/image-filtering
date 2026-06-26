/**
 * Framework-agnostic filter-engine contract.
 *
 * Filter *execution* is decoupled from *display* (Cornerstone) and from any one
 * GPU library. Every engine — Babylon (GPU), CPU baseline — implements this
 * same interface, so they can be swapped and benchmarked apples-to-apples.
 *
 * Engines work on single-channel grayscale at native bit depth (Float32 of the
 * stored pixel values, which may be signed/HU for CT), and emit a display-ready
 * 0..OUTPUT_MAX image (the filter does its own windowing, so what you see is
 * exactly what the filter computed).
 */

import type { Lut } from "../luts/types";

/** Output images are normalized to this range (12-bit), displayed linearly. */
export const OUTPUT_MAX = 4095;

/** A grayscale image at native bit depth. `data` is row-major, length w*h. */
export interface ImageBuffer {
  width: number;
  height: number;
  data: Float32Array;
  /** Lowest / highest stored pixel value. */
  min: number;
  max: number;
  /** Default display window (in stored-value units) — from DICOM or min/max. */
  defaultCenter: number;
  defaultWidth: number;
}

/** The filter graph parameters. Identical math is implemented by every engine. */
export interface FilterParams {
  /**
   * Fit the base display window to the image histogram (percentile stretch)
   * instead of the DICOM default. Brightness/contrast still modulate it.
   */
  autoWindow: boolean;
  /** Window-center shift, in units of the default width. -1..1, 0 = off. */
  brightness: number;
  /** Window-width scale (contrast). >1 narrows the window. 0.2..4, 1 = off. */
  contrast: number;
  /** CLAHE local-contrast strength — blend windowed↔equalized. 0..1, 0 = off. */
  clahe: number;
  /** CLAHE clip limit (× average bin height). 1..6, lower = gentler/less noise. */
  claheClip: number;
  /** Noise reduction — blend toward a 3x3 blur. 0..1, 0 = off. */
  denoise: number;
  /** Unsharp-mask strength. 0..10, 0 = off. */
  sharpen: number;
  /** Sobel edge-detect blend. 0..1, 0 = off. */
  edge: number;
  /** Display gamma. 0.2..3, 1 = off. */
  gamma: number;
  /** Photometric invert. */
  invert: boolean;
  /**
   * Tone-curve LUT id (see luts/registry). "none" = off. Applied after gamma,
   * before edge/invert. The engine looks the id up in its registered tables;
   * an unknown id is treated as "none".
   */
  lut: string;

  // ---- tissue segmentation (tooth vs bone vs soft tissue) -----------------
  /** Master enable for intensity segmentation + per-class processing. */
  segEnabled: boolean;
  /** Auto-pick thresholds with Otsu (else use segT1/segT2). */
  segAuto: boolean;
  /** Tissue|bone boundary in windowed [0,1] (manual mode). */
  segT1: number;
  /** Bone|tooth boundary in windowed [0,1] (manual mode). */
  segT2: number;
  /** Soft-membership transition half-width around each threshold. 0..0.25. */
  segFeather: number;
  /** Per-class contrast (gain around 0.5) and brightness (bias). 1/0 = neutral. */
  segTissueGain: number;
  segTissueBias: number;
  segBoneGain: number;
  segToothGain: number;
  segToothBias: number;
  /** "normal" grayscale, or "map" = pseudocolor class overlay. */
  segView: "normal" | "map";
  /** Faint per-class tint in the normal view (needs the RGB path). */
  segTint: boolean;
}

export const DEFAULT_FILTERS: FilterParams = {
  autoWindow: false,
  brightness: 0,
  contrast: 1,
  clahe: 0,
  claheClip: 3,
  denoise: 0,
  sharpen: 0,
  edge: 0,
  gamma: 1,
  invert: false,
  lut: "none",
  segEnabled: false,
  segAuto: true,
  segT1: 0.33,
  segT2: 0.66,
  segFeather: 0.05,
  segTissueGain: 0.85,
  segTissueBias: 0.04,
  segBoneGain: 1.0,
  segToothGain: 1.4,
  segToothBias: 0,
  segView: "normal",
  segTint: false,
};

export interface FilterResult {
  data: Float32Array;
  width: number;
  height: number;
  /** 1 = grayscale (row-major), 3 = interleaved RGB (for class-map / tint). */
  components: 1 | 3;
  min: number;
  max: number;
  /**
   * Wall-clock ms inside the engine: parameter upload + compute + (GPU) readback.
   * Excludes the one-time source upload in setImage(). This is the benchmark number.
   */
  elapsedMs: number;
}

export interface FilterEngine {
  readonly name: string;
  /** Graphics backend label (e.g. "WebGL2", "JavaScript") — set after init(). */
  backend?: string;
  isAvailable(): boolean;
  init(): Promise<void>;
  setImage(img: ImageBuffer): Promise<void>;
  /**
   * Register (or replace) a tone-curve LUT by id so it can be selected via
   * FilterParams.lut. Idempotent; safe to call before or after setImage.
   */
  registerLut(lut: Lut): void;
  run(params: FilterParams): Promise<FilterResult>;
  dispose(): void;
}
