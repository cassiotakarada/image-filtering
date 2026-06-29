/**
 * Cornerstone3D's "real" DICOM parsing path — `@cornerstonejs/dicom-image-loader`.
 *
 * This file exists ONLY for the end-to-end open+parse+render benchmark, where
 * we want to time Cornerstone's official wadouri pipeline (file → dataset →
 * decoded pixel data → cornerstone Image). The rest of the app uses our
 * hand-rolled `dicom-parser` driver in `loadDicomFiles.ts`, which is faster to
 * initialise and avoids the worker entirely.
 *
 * The loader is lazy: `initCornerstoneDicomLoader()` is called from the
 * benchmark on first use. Init failures are captured (not thrown) so the
 * corresponding bench rows show `n/a` with a reason instead of breaking the
 * whole benchmark.
 *
 * Init registers `dicomfile:` / `wadouri:` / `dicomweb:` image loaders on the
 * shared `@cornerstonejs/core` registry, alongside our own `source:` /
 * `filtered:` loaders — the scheme prefixes don't collide.
 */
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import { imageLoader as csImageLoader } from "@cornerstonejs/core";
import type { ImageBuffer } from "../engine/types";

let initialized = false;
let initFailed: string | null = null;

/**
 * Idempotent init. Returns true on success, false if the loader could not be
 * initialised (e.g. worker spawn failed under Vite). After a failure, further
 * calls short-circuit to false.
 */
export async function initCornerstoneDicomLoader(): Promise<boolean> {
  if (initialized) return true;
  if (initFailed) return false;
  try {
    // One worker is enough for the bench (we only decode the active slice).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (dicomImageLoader as any).init({ maxWebWorkers: 1 });
    initialized = true;
    return true;
  } catch (e) {
    initFailed = e instanceof Error ? e.message : String(e);
    return false;
  }
}

export function cornerstoneDicomLoaderReady(): boolean {
  return initialized;
}

export function cornerstoneDicomLoaderError(): string | null {
  return initFailed;
}

/**
 * Register a `File` with the loader's file manager and return a `dicomfile:N`
 * image id. Each call appends a new file, getting a fresh index — so even with
 * the same `File`, the returned imageId is unique and avoids Cornerstone's
 * image cache (important for benchmark samples that must re-do the full load).
 */
export function addFileForCornerstoneLoad(file: File): string {
  return dicomImageLoader.wadouri.fileManager.add(file);
}

/**
 * Clear the loader's file-manager array. Useful between benchmark runs so it
 * doesn't grow unbounded. Note: this does NOT clear Cornerstone's image cache
 * — the imageIds remain valid in that cache until evicted normally.
 */
export function purgeCornerstoneFileManager(): void {
  dicomImageLoader.wadouri.fileManager.purge();
}

/**
 * Full Cornerstone open+parse path for a single File: register the file,
 * load+decode it through cornerstone, return the decoded pixel data as the
 * engine-facing `ImageBuffer` (Float32 + default window).
 *
 * Throws if the loader is not initialised, or if the file isn't a DICOM image.
 * Used by the "Babylon · Cornerstone-parsed" benchmark rows.
 */
export async function loadDicomFileViaCornerstone(file: File): Promise<{
  buffer: ImageBuffer;
  imageId: string;
}> {
  if (!initialized) {
    throw new Error(initFailed ?? "cornerstone DICOM loader not initialised");
  }
  const imageId = addFileForCornerstoneLoad(file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const image: any = await csImageLoader.loadAndCacheImage(imageId);
  return { buffer: cornerstoneImageToImageBuffer(image), imageId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cornerstoneImageToImageBuffer(image: any): ImageBuffer {
  const raw: ArrayLike<number> = image.getPixelData();
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i];

  const slope: number = image.slope ?? 1;
  const intercept: number = image.intercept ?? 0;
  const wcArr = image.windowCenter;
  const wwArr = image.windowWidth;
  const wc = Array.isArray(wcArr) ? wcArr[0] : wcArr;
  const ww = Array.isArray(wwArr) ? wwArr[0] : wwArr;
  let defaultCenter: number;
  let defaultWidth: number;
  if (isFinite(wc) && isFinite(ww) && ww > 0 && slope !== 0) {
    // DICOM window is in MODALITY (rescaled) units; engines window in
    // STORED units, so undo the rescale.
    defaultCenter = (wc - intercept) / slope;
    defaultWidth = ww / slope;
  } else {
    defaultCenter = (image.minPixelValue + image.maxPixelValue) / 2;
    defaultWidth = image.maxPixelValue - image.minPixelValue || 1;
  }

  return {
    width: image.columns,
    height: image.rows,
    data,
    min: image.minPixelValue,
    max: image.maxPixelValue,
    defaultCenter,
    defaultWidth,
  };
}
