/**
 * In-browser DICOM parsing for the spike's "Load CT folder" feature.
 *
 * COMPLIANCE: reads ONLY geometry/pixel tags (rows, columns, bits, rescale,
 * window, instance number) and the pixel data. It never reads PatientName or
 * any identifier, never logs file contents, and the files stay in the browser
 * (the user picks them; nothing is uploaded or written to disk).
 *
 * Uncompressed transfer syntaxes only (implicit/explicit VR Little Endian) —
 * the JPEG/JPEG2000 codecs were intentionally dropped, so compressed series are
 * reported as skipped rather than decoded.
 */
import dicomParser from "dicom-parser";
import { decodeJ2KSingle } from "./decodeCompressed";

export interface Slice {
  data: Int16Array | Uint16Array | Uint8Array;
  width: number;
  height: number;
  /** Stored-value range (pre rescale). */
  min: number;
  max: number;
  slope: number;
  intercept: number;
  /** Window center/width in modality (HU) units. */
  wc: number;
  ww: number;
  signed: boolean;
  instanceNumber: number;
}

export interface ParseOutcome {
  slices: Slice[];
  /**
   * Source `File` for each entry in `slices`, in the SAME order (i.e.
   * `sourceFiles[i]` is the file that produced `slices[i]` after the
   * instance-number sort). The benchmark needs this to re-open the active
   * slice's original bytes on every sample.
   */
  sourceFiles: File[];
  skippedCompressed: number;
  skippedOther: number;
  /** Compressed transfer-syntax UIDs encountered → count (for diagnostics). */
  compressedSyntaxes: Record<string, number>;
}

const UNCOMPRESSED_TS = new Set([
  "1.2.840.10008.1.2", // implicit VR LE
  "1.2.840.10008.1.2.1", // explicit VR LE
]);

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2.1.99": "Deflated Explicit VR LE",
  "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline (8-bit)",
  "1.2.840.10008.1.2.4.51": "JPEG Extended (12-bit)",
  "1.2.840.10008.1.2.4.57": "JPEG Lossless",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.201": "High-Throughput JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.202": "High-Throughput JPEG 2000 Lossless RPCL",
  "1.2.840.10008.1.2.4.203": "High-Throughput JPEG 2000",
  "1.2.840.10008.1.2.5": "RLE Lossless",
};

export function describeTransferSyntax(uid: string): string {
  return TS_NAMES[uid] ? `${TS_NAMES[uid]} (${uid})` : uid;
}

export async function parseDicomFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<ParseOutcome> {
  // Pair each slice with its source file so we can keep them aligned through
  // the instance-number sort below.
  const pairs: { slice: Slice; file: File }[] = [];
  let skippedCompressed = 0;
  let skippedOther = 0;
  const compressedSyntaxes: Record<string, number> = {};

  for (let i = 0; i < files.length; i++) {
    try {
      const buf = await files[i].arrayBuffer();
      const r = parseDicomBytes(buf);
      if (typeof r === "object" && r !== null && "compressed" in r) {
        skippedCompressed++;
        compressedSyntaxes[r.compressed] = (compressedSyntaxes[r.compressed] ?? 0) + 1;
      } else if (r === null) {
        skippedOther++;
      } else {
        pairs.push({ slice: r, file: files[i] });
      }
    } catch {
      skippedOther++;
    }
    onProgress?.(i + 1, files.length);
  }

  pairs.sort((a, b) => a.slice.instanceNumber - b.slice.instanceNumber);
  return {
    slices: pairs.map((p) => p.slice),
    sourceFiles: pairs.map((p) => p.file),
    skippedCompressed,
    skippedOther,
    compressedSyntaxes,
  };
}

/**
 * Parse one DICOM file's bytes (uncompressed transfer syntaxes only). Returns
 * the decoded `Slice`, an object describing why parsing was skipped
 * (`{compressed}` for compressed-transfer-syntax files), or `null` for files
 * we couldn't recognise as DICOM images. Exposed for the single-file load
 * path used by the open+parse+render benchmark.
 */
export function parseDicomBytes(
  buf: ArrayBuffer
): Slice | { compressed: string } | null {
  const bytes = new Uint8Array(buf);
  const ds = dicomParser.parseDicom(bytes);

  const ts = ds.string("x00020010") || "";
  if (ts && !UNCOMPRESSED_TS.has(ts)) {
    return { compressed: ts };
  }

  const cols = ds.uint16("x00280011");
  const rows = ds.uint16("x00280010");
  if (!cols || !rows) return null;

  const bitsAllocated = ds.uint16("x00280100") || 16;
  const signed = (ds.uint16("x00280103") || 0) === 1;
  const slope = parseFloat(ds.string("x00281053") || "1") || 1;
  const intercept = parseFloat(ds.string("x00281052") || "0") || 0;

  const pixelEl = ds.elements["x7fe00010"];
  if (!pixelEl) return null;

  const count = rows * cols;
  let data: Int16Array | Uint16Array | Uint8Array;
  if (bitsAllocated <= 8) {
    data = new Uint8Array(buf.slice(pixelEl.dataOffset, pixelEl.dataOffset + count));
  } else {
    const sliceBuf = buf.slice(pixelEl.dataOffset, pixelEl.dataOffset + count * 2);
    data = signed ? new Int16Array(sliceBuf) : new Uint16Array(sliceBuf);
  }

  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }

  let wc = NaN;
  let ww = NaN;
  const wcStr = ds.string("x00281050");
  const wwStr = ds.string("x00281051");
  if (wcStr) wc = parseFloat(wcStr.split("\\")[0]);
  if (wwStr) ww = parseFloat(wwStr.split("\\")[0]);
  if (!isFinite(wc) || !isFinite(ww) || ww <= 0) {
    const huMin = mn * slope + intercept;
    const huMax = mx * slope + intercept;
    wc = (huMin + huMax) / 2;
    ww = huMax - huMin || 1;
  }

  const instanceNumber = parseInt(ds.string("x00200013") || "0", 10) || 0;

  return { data, width: cols, height: rows, min: mn, max: mx, slope, intercept, wc, ww, signed, instanceNumber };
}

// ---- single-file load path (for the open+parse+render benchmark) ----------

/**
 * Convert a parsed `Slice` into the engine-facing `ImageBuffer` shape: stored
 * pixels copied into a `Float32Array`, plus a default window in stored-value
 * units (the engines window the raw stored buffer).
 */
export function sliceToImageBuffer(
  s: Slice
): import("../engine/types").ImageBuffer {
  const data = new Float32Array(s.data.length);
  for (let i = 0; i < s.data.length; i++) data[i] = s.data[i];

  // `s.wc`/`s.ww` are in MODALITY (rescaled) units; engines window in STORED
  // units, so undo the rescale to keep the default window consistent with
  // what `cornerstoneSetup.loadImageBuffer` produces.
  let defaultCenter: number;
  let defaultWidth: number;
  if (isFinite(s.wc) && isFinite(s.ww) && s.ww > 0 && s.slope !== 0) {
    defaultCenter = (s.wc - s.intercept) / s.slope;
    defaultWidth = s.ww / s.slope;
  } else {
    defaultCenter = (s.min + s.max) / 2;
    defaultWidth = s.max - s.min || 1;
  }

  return {
    width: s.width,
    height: s.height,
    data,
    min: s.min,
    max: s.max,
    defaultCenter,
    defaultWidth,
  };
}

/**
 * Open + parse one DICOM File using the in-house `dicom-parser` driver (the
 * "current library" path, in contrast to the Cornerstone wadouri loader in
 * `cornerstoneDicomLoader.ts`). Handles uncompressed + JPEG 2000; throws on
 * anything else. Used by the open+parse+render benchmark.
 *
 * The static import of `decodeCompressed` is safe — its only back-reference
 * to this file is a `type`-only import (`type { Slice }`), which is erased
 * at runtime and doesn't create a circular load.
 */
export async function loadDicomFileRaw(
  file: File
): Promise<import("../engine/types").ImageBuffer> {
  const buf = await file.arrayBuffer();
  const r = parseDicomBytes(buf);
  if (r === null) throw new Error("not a DICOM image");
  if ("compressed" in r) {
    const slice = await decodeJ2KSingle(buf);
    if (!slice) {
      throw new Error(`unsupported compressed transfer syntax ${r.compressed}`);
    }
    return sliceToImageBuffer(slice);
  }
  return sliceToImageBuffer(r);
}
