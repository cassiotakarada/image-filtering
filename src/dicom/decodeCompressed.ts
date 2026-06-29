/**
 * Compressed-DICOM decoding — JPEG 2000, on the MAIN THREAD.
 *
 * We tried Cornerstone's dicom-image-loader, but its web-worker decode path
 * hangs under Vite (the worker never resolves). So instead we drive the
 * OpenJPEG WASM codec directly: extract the encapsulated J2K codestream with
 * dicom-parser, decode it inline, and wrap the result as the same `Slice` shape
 * the uncompressed parser produces. No workers → no hang.
 *
 * Handles JPEG 2000 (.90 lossless / .91). Other compressed syntaxes (JPEG-LS,
 * JPEG lossless, RLE) would each need their own codec and are reported as
 * unsupported rather than decoded.
 *
 * COMPLIANCE: reads only geometry/pixel/window tags; files stay in-browser.
 */
import dicomParser from "dicom-parser";
import OpenJPEGFactory from "@cornerstonejs/codec-openjpeg/decode";
import type { Slice } from "./loadDicomFiles";

const JPEG2000 = new Set(["1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modulePromise: Promise<any> | null = null;
function getOpenJpeg() {
  // Self-contained build (wasm inlined) — no locateFile needed.
  if (!modulePromise) modulePromise = OpenJPEGFactory();
  return modulePromise;
}

export async function decodeCompressedFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<{ slices: Slice[]; sourceFiles: File[] }> {
  const openjpeg = await getOpenJpeg();
  // Pair each decoded slice with its source File so we can keep them aligned
  // through the instance-number sort. The benchmark needs the original File
  // for the active slice to re-time open+parse on every sample.
  const pairs: { slice: Slice; file: File }[] = [];

  for (let i = 0; i < files.length; i++) {
    try {
      const buf = await files[i].arrayBuffer();
      const s = decodeOne(buf, openjpeg);
      if (s) pairs.push({ slice: s, file: files[i] });
    } catch {
      /* undecodable — skip */
    }
    onProgress?.(i + 1, files.length);
    // Yield occasionally so the UI/progress stays responsive on big series.
    if (i % 4 === 3) await new Promise((r) => setTimeout(r));
  }

  pairs.sort((a, b) => a.slice.instanceNumber - b.slice.instanceNumber);
  return {
    slices: pairs.map((p) => p.slice),
    sourceFiles: pairs.map((p) => p.file),
  };
}

/**
 * Decode a single compressed DICOM (JPEG 2000) buffer to a `Slice`. Returns
 * `null` if the file isn't a supported compressed transfer syntax. Exposed
 * for the single-file load path used by the open+parse+render benchmark.
 */
export async function decodeJ2KSingle(buf: ArrayBuffer): Promise<Slice | null> {
  const openjpeg = await getOpenJpeg();
  return decodeOne(buf, openjpeg);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeOne(buf: ArrayBuffer, openjpeg: any): Slice | null {
  const bytes = new Uint8Array(buf);
  const ds = dicomParser.parseDicom(bytes);

  const ts = ds.string("x00020010") || "";
  if (!JPEG2000.has(ts)) return null;

  const pixelEl = ds.elements["x7fe00010"];
  if (!pixelEl) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dp = dicomParser as any;
  let encoded: Uint8Array;
  try {
    encoded = dp.readEncapsulatedImageFrame(ds, pixelEl, 0);
  } catch {
    encoded = dp.readEncapsulatedPixelDataFromFragments(ds, pixelEl, 0);
  }

  const decoder = new openjpeg.J2KDecoder();
  try {
    const inBuf = decoder.getEncodedBuffer(encoded.length);
    inBuf.set(encoded);
    decoder.decode();

    const fi = decoder.getFrameInfo();
    const width: number = fi.width;
    const height: number = fi.height;
    const signed = !!fi.isSigned;
    const decoded: Uint8Array = decoder.getDecodedBuffer();
    const n = width * height;

    let data: Int16Array | Uint16Array | Uint8Array;
    if (fi.bitsPerSample <= 8) {
      data = Uint8Array.from(decoded.subarray(0, n));
    } else {
      // Copy out of the WASM heap (browsers are little-endian, matching J2K output).
      const sliceBuf = decoded.buffer.slice(
        decoded.byteOffset,
        decoded.byteOffset + n * 2
      );
      data = signed ? new Int16Array(sliceBuf) : new Uint16Array(sliceBuf);
    }

    const slope = parseFloat(ds.string("x00281053") || "1") || 1;
    const intercept = parseFloat(ds.string("x00281052") || "0") || 0;

    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    let wc = NaN;
    let ww = NaN;
    const wcS = ds.string("x00281050");
    const wwS = ds.string("x00281051");
    if (wcS) wc = parseFloat(wcS.split("\\")[0]);
    if (wwS) ww = parseFloat(wwS.split("\\")[0]);
    if (!isFinite(wc) || !isFinite(ww) || ww <= 0) {
      const a = mn * slope + intercept;
      const b = mx * slope + intercept;
      wc = (a + b) / 2;
      ww = b - a || 1;
    }

    const instanceNumber = parseInt(ds.string("x00200013") || "0", 10) || 0;

    return { data, width, height, min: mn, max: mx, slope, intercept, wc, ww, signed, instanceNumber };
  } finally {
    decoder.delete?.();
  }
}
