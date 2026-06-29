/**
 * Cornerstone3D integration + the "filter seam".
 *
 * Custom image-id schemes flow through one StackViewport:
 *   source:phantom-N  / source:slice-N   → source images (synthetic or real CT)
 *   filtered:result-N                     → GPU/CPU filter output
 *
 * All served by a custom Cornerstone image loader. We deliberately do NOT use
 * @cornerstonejs/dicom-image-loader (its eager JPEG/JPEG2000 codec imports break
 * under Vite, and we only handle uncompressed data). Real CT is parsed in the
 * browser by loadDicomFiles.ts. Filtered results inherit the source slice's
 * rescale + window/level so they display identically.
 */
import {
  init as csRenderInit,
  RenderingEngine,
  Enums,
  imageLoader,
  metaData,
} from "@cornerstonejs/core";
import type { FilterResult, ImageBuffer } from "../engine/types";
import { makePhantom } from "./syntheticDicom";
import type { Slice } from "./loadDicomFiles";

const ENGINE_ID = "spikeRenderingEngine";
const VIEWPORT_ID = "spikeStackViewport";

type PixelArray = Int16Array | Uint16Array | Uint8Array | Float32Array;

interface Stored {
  data: PixelArray;
  width: number;
  height: number;
  min: number;
  max: number;
  slope: number;
  intercept: number;
  wc: number;
  ww: number;
  signed: boolean;
  /** 1 = grayscale, 3 = interleaved RGB (filter class-map / tint output). */
  components: number;
}

const store = new Map<string, Stored>();
const filteredQueue: string[] = [];
let counter = 0;
let renderingEngine: RenderingEngine | null = null;
let initialized = false;

export async function initCornerstone(): Promise<void> {
  if (initialized) return;
  await csRenderInit();
  registerLoaders();
  initialized = true;
}

function bitsAllocatedOf(data: PixelArray): number {
  if (data instanceof Uint8Array) return 8;
  if (data instanceof Float32Array) return 32;
  return 16;
}

function makeImage(imageId: string, s: Stored) {
  const isColor = s.components === 3;
  return {
    imageId,
    minPixelValue: s.min,
    maxPixelValue: s.max,
    slope: s.slope,
    intercept: s.intercept,
    windowCenter: s.wc,
    windowWidth: s.ww,
    getPixelData: () => s.data,
    getCanvas: undefined,
    rows: s.height,
    columns: s.width,
    height: s.height,
    width: s.width,
    color: isColor,
    rgba: false,
    numberOfComponents: s.components,
    columnPixelSpacing: 1,
    rowPixelSpacing: 1,
    invert: false,
    sizeInBytes: s.data.byteLength,
    photometricInterpretation: isColor ? "RGB" : "MONOCHROME2",
    voiLUTFunction: "LINEAR",
    dataType: s.data.constructor.name,
  };
}

function registerLoaders() {
  const load = (imageId: string) => {
    const s = store.get(imageId);
    const promise = new Promise((resolve, reject) => {
      if (!s) {
        reject(new Error(`unknown image: ${imageId}`));
        return;
      }
      resolve(makeImage(imageId, s));
    });
    return { promise };
  };

  imageLoader.registerImageLoader("source", load as never);
  imageLoader.registerImageLoader("filtered", load as never);

  metaData.addProvider((type: string, imageId: string) => {
    if (
      typeof imageId !== "string" ||
      (!imageId.startsWith("source:") && !imageId.startsWith("filtered:"))
    )
      return;
    const s = store.get(imageId);
    if (!s) return;
    switch (type) {
      case "imagePixelModule":
        return {
          bitsAllocated: bitsAllocatedOf(s.data),
          bitsStored: bitsAllocatedOf(s.data),
          highBit: bitsAllocatedOf(s.data) - 1,
          photometricInterpretation: s.components === 3 ? "RGB" : "MONOCHROME2",
          pixelRepresentation: s.signed ? 1 : 0,
          samplesPerPixel: s.components,
          planarConfiguration: 0,
          rows: s.height,
          columns: s.width,
        };
      case "voiLutModule":
        return { windowCenter: [s.wc], windowWidth: [s.ww] };
      case "modalityLutModule":
        return { rescaleIntercept: s.intercept, rescaleSlope: s.slope };
      case "generalSeriesModule":
        return { modality: "OT" };
      case "imagePlaneModule":
        return {
          rows: s.height,
          columns: s.width,
          rowCosines: [1, 0, 0],
          columnCosines: [0, 1, 0],
          imagePositionPatient: [0, 0, 0],
          imageOrientationPatient: [1, 0, 0, 0, 1, 0],
          pixelSpacing: [1, 1],
          rowPixelSpacing: 1,
          columnPixelSpacing: 1,
        };
      default:
        return undefined;
    }
  }, 10000);
}

export function setupViewport(element: HTMLDivElement): void {
  renderingEngine = new RenderingEngine(ENGINE_ID);
  renderingEngine.enableElement({
    viewportId: VIEWPORT_ID,
    type: Enums.ViewportType.STACK,
    element,
    defaultOptions: { background: [0, 0, 0] as [number, number, number] },
  });
}

/**
 * Force Cornerstone to resize its internal canvas to match the current
 * element box. We need this because `setupViewport` runs once at init
 * (when the cornerstone viewport widget might be `display:none` because
 * a non-cornerstone live mode is the default), so the canvas drawing
 * buffer ends up at the HTMLCanvasElement default of 300\u00d7150. When the
 * user later switches to a cornerstone live mode, the element box
 * becomes the full ~420\u00d7420 viewport-wrap square, but the canvas
 * backing buffer stays 300\u00d7150 \u2014 CSS stretches that 300\u00d7150 framebuffer
 * to fill the box, distorting the image horizontally (and worse,
 * vertically). Calling this after the element becomes visible fixes it.
 */
export function resizeCornerstoneViewport(): void {
  renderingEngine?.resize(true, true);
}

export async function showImage(imageId: string): Promise<void> {
  if (!renderingEngine) throw new Error("viewport not set up");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vp = renderingEngine.getViewport(VIEWPORT_ID) as any;
  await vp.setStack([imageId]);
  vp.render();
}

/** Generate a synthetic phantom, register it as a `source:` image. */
export function makeSourceImage(size = 512): { imageId: string } {
  const p = makePhantom(size);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < p.pixels.length; i++) {
    const v = p.pixels[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  counter += 1;
  const imageId = `source:phantom-${size}-${counter}`;
  store.set(imageId, {
    data: p.pixels,
    width: p.width,
    height: p.height,
    min: mn,
    max: mx,
    slope: 1,
    intercept: 0,
    wc: (mn + mx) / 2,
    ww: mx - mn || 1,
    signed: false,
    components: 1,
  });
  return { imageId };
}

/** Register parsed CT slices as `source:` images; returns ids in slice order. */
export function registerSlices(slices: Slice[]): string[] {
  const ids: string[] = [];
  for (const s of slices) {
    counter += 1;
    const imageId = `source:slice-${counter}`;
    store.set(imageId, {
      data: s.data,
      width: s.width,
      height: s.height,
      min: s.min,
      max: s.max,
      slope: s.slope,
      intercept: s.intercept,
      wc: s.wc,
      ww: s.ww,
      signed: s.signed,
      components: 1,
    });
    ids.push(imageId);
  }
  return ids;
}

/** Decode an imageId through Cornerstone and hand back a Float32 ImageBuffer. */
export async function loadImageBuffer(imageId: string): Promise<ImageBuffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const image: any = await imageLoader.loadAndCacheImage(imageId);
  const raw: ArrayLike<number> = image.getPixelData();
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i];

  const min: number = image.minPixelValue;
  const max: number = image.maxPixelValue;

  // Default display window, in STORED-value units (the engine windows raw
  // stored pixels). Prefer the DICOM window (converted out of modality units);
  // fall back to full range.
  const slope: number = image.slope ?? 1;
  const intercept: number = image.intercept ?? 0;
  let wc = Array.isArray(image.windowCenter) ? image.windowCenter[0] : image.windowCenter;
  let ww = Array.isArray(image.windowWidth) ? image.windowWidth[0] : image.windowWidth;
  let defaultCenter: number;
  let defaultWidth: number;
  if (isFinite(wc) && isFinite(ww) && ww > 0 && slope !== 0) {
    defaultCenter = (wc - intercept) / slope;
    defaultWidth = ww / slope;
  } else {
    defaultCenter = (min + max) / 2;
    defaultWidth = max - min || 1;
  }

  return {
    width: image.columns,
    height: image.rows,
    data,
    min,
    max,
    defaultCenter,
    defaultWidth,
  };
}

// --- Cornerstone's own GPU windowing, for benchmarking --------------------
// Cornerstone3D renders on the GPU (WebGL) and applies window/level there. To
// compare it against Babylon fairly we time its real display path: set the VOI
// and render to an offscreen viewport, measured to the IMAGE_RENDERED event.
// NOTE: this only does WINDOWING — Cornerstone has no CLAHE/sharpen/segmentation
// equivalent, so it's a baseline for the one operation both engines share.
const BENCH_ENGINE_ID = "spikeBenchEngine";
const BENCH_VIEWPORT_ID = "spikeBenchViewport";
let benchEngine: RenderingEngine | null = null;
let benchElement: HTMLDivElement | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let benchViewport: any = null;

function ensureBenchViewport(): void {
  if (benchViewport) return;
  benchElement = document.createElement("div");
  benchElement.style.cssText =
    "position:fixed;left:-10000px;top:0;width:512px;height:512px;";
  document.body.appendChild(benchElement);
  benchEngine = new RenderingEngine(BENCH_ENGINE_ID);
  benchEngine.enableElement({
    viewportId: BENCH_VIEWPORT_ID,
    type: Enums.ViewportType.STACK,
    element: benchElement,
    defaultOptions: { background: [0, 0, 0] as [number, number, number] },
  });
  benchViewport = benchEngine.getViewport(BENCH_VIEWPORT_ID);
}

/**
 * Detect the WebGL version Cornerstone/vtk.js renders with.
 *
 * NOTE: Cornerstone3D renders to ONE shared offscreen WebGL2 surface, then
 * blits the result to each viewport's visible canvas with a 2D drawImage — so
 * probing the viewport canvas finds a 2D context, not WebGL. Instead we probe a
 * throwaway canvas for the WebGL capability of the same browser/GPU Cornerstone
 * uses (Cornerstone3D requires WebGL2).
 */
export function cornerstoneBackend(): string {
  try {
    const c = document.createElement("canvas");
    if (c.getContext("webgl2")) return "WebGL2";
    if (c.getContext("webgl")) return "WebGL1";
  } catch {
    /* ignore */
  }
  return "no WebGL";
}

/**
 * Probe for Cornerstone3D's WebGPU backend.
 *
 * Cornerstone3D 4.15.x has no WebGPU backend (verified against the v4.15.21
 * tag: init.ts only probes webgl2/webgl/experimental-webgl, no navigator.gpu
 * path). This is a documentation-only probe: it allocates nothing, renders
 * nothing, and always reports `ms: null` to the benchmark. It distinguishes
 * two distinct failure modes so reviewers can tell them apart:
 *
 *   - Browser supports WebGPU but Cornerstone3D doesn't expose it →
 *     backend `"WebGPU (no Cornerstone support)"`, note
 *     `"Cornerstone3D 4.15 has no WebGPU backend"`.
 *   - Browser itself lacks WebGPU →
 *     backend `"WebGPU not available"`, note `"WebGPU not available"`.
 *
 * If/when upstream ships a WebGPU backend, this probe is the single point
 * that swaps to a real renderer.
 */
export function cornerstoneBenchProbeWebGPU(): {
  backend: string;
  note: string;
} {
  const hasWebGPU =
    typeof navigator !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (navigator as any).gpu !== "undefined";
  if (hasWebGPU) {
    return {
      backend: "WebGPU (no Cornerstone support)",
      note: "Cornerstone3D 4.15 has no WebGPU backend",
    };
  }
  return {
    backend: "WebGPU not available",
    note: "WebGPU not available",
  };
}

/**
 * Show `imageId` in the offscreen bench viewport and resolve once the
 * `IMAGE_RENDERED` event fires (i.e. pixels are on the canvas). This is the
 * "render-to-screen" step of the open+parse+render benchmark — used for ALL
 * row types (cornerstone direct, babylon-filtered result, cpu-filtered result)
 * so the display cost is identical across rows.
 *
 * Rejects after 30s so a hung load doesn't lock up the whole benchmark.
 */
export function benchDisplayImage(imageId: string): Promise<void> {
  ensureBenchViewport();
  return new Promise<void>((resolve, reject) => {
    const el = benchElement!;
    let settled = false;
    const cleanup = () => {
      el.removeEventListener(Enums.Events.IMAGE_RENDERED, onRendered);
      clearTimeout(timer);
    };
    const onRendered = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("bench display timed out (30s)"));
    }, 30_000);
    el.addEventListener(Enums.Events.IMAGE_RENDERED, onRendered);
    benchViewport.setStack([imageId]).then(
      () => benchViewport.render(),
      (e: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * Store a filter result and return a `filtered:` imageId. The engine already
 * did the windowing, so we display the 0..OUTPUT_MAX output linearly.
 */
export function registerFilteredResult(r: FilterResult): string {
  counter += 1;
  const imageId = `filtered:result-${counter}`;

  if (r.components === 3) {
    // Color (class-map / tint): bake to display-ready 8-bit RGB. The engine
    // already produced 0..max per channel, so we just rescale to 0..255 and let
    // Cornerstone pass it through (window = full 8-bit range).
    const scale = 255 / (r.max || 1);
    const rgb = new Uint8Array(r.width * r.height * 3);
    for (let i = 0; i < rgb.length; i++) {
      let v = Math.round(r.data[i] * scale);
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      rgb[i] = v;
    }
    store.set(imageId, {
      data: rgb,
      width: r.width,
      height: r.height,
      min: 0,
      max: 255,
      slope: 1,
      intercept: 0,
      wc: 127.5,
      ww: 255,
      signed: false,
      components: 3,
    });
  } else {
    const u16 = new Uint16Array(r.data.length);
    for (let i = 0; i < u16.length; i++) {
      let v = Math.round(r.data[i]);
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      u16[i] = v;
    }
    store.set(imageId, {
      data: u16,
      width: r.width,
      height: r.height,
      min: r.min,
      max: r.max,
      slope: 1,
      intercept: 0,
      wc: (r.min + r.max) / 2,
      ww: r.max - r.min || 1,
      signed: false,
      components: 1,
    });
  }

  // Evict only old FILTERED images — never source slices.
  filteredQueue.push(imageId);
  while (filteredQueue.length > 8) {
    const old = filteredQueue.shift();
    if (old) store.delete(old);
  }
  return imageId;
}
