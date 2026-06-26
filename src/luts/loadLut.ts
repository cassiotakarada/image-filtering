import { STD_LUT_SIZE, type Lut } from "./types";

/**
 * Format-tolerant loader for *validated* LUT files.
 *
 * Accepts the common ways a 1-D grayscale tone curve gets exported, so you can
 * usually drop a file in without converting it first:
 *
 *   • JSON array:        [0, 4, 9, ... ]
 *   • JSON object:       { "name": "...", "values": [...] }
 *   • JSON control pts:  { "name": "...", "points": [[0,0],[128,90],[255,255]] }
 *   • Delimited text:    whitespace / comma / semicolon / newline separated numbers
 *
 * Value range is auto-detected: if the max exceeds ~1.5 the table is assumed to
 * be 0..255 (8-bit) or 0..4095 (12-bit) and normalized accordingly. The result
 * is resampled (linear) to STD_LUT_SIZE and clamped to [0,1].
 *
 * If your validated LUTs use a format this doesn't read, send me one sample and
 * I'll extend the parser — the rest of the pipeline stays the same.
 */
export async function loadLutFromFile(file: File): Promise<Lut> {
  const text = await file.text();
  const id = slugify(file.name);
  const fallbackName = prettyName(file.name);

  const parsed = parseLut(text);
  const values = resample(normalize(parsed.values), STD_LUT_SIZE);
  return { id, name: parsed.name ?? fallbackName, size: STD_LUT_SIZE, values };
}

interface ParsedLut {
  name?: string;
  values: number[];
}

function parseLut(text: string): ParsedLut {
  const trimmed = text.trim();

  // Try JSON first.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) {
        if (Array.isArray(json[0])) return { values: pointsToCurve(json as number[][]) };
        return { values: json.map(Number) };
      }
      if (json && typeof json === "object") {
        const name = typeof json.name === "string" ? json.name : undefined;
        if (Array.isArray(json.values)) return { name, values: json.values.map(Number) };
        if (Array.isArray(json.points)) return { name, values: pointsToCurve(json.points) };
      }
    } catch {
      /* fall through to delimited parsing */
    }
  }

  // Delimited / free-form numbers. Skip comment lines (#, //).
  const cleaned = trimmed
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
  const nums = cleaned
    .split(/[\s,;]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length < 2) throw new Error("LUT file has fewer than 2 numeric entries");
  return { values: nums };
}

/** Build a dense curve from [input, output] control points (any scale). */
function pointsToCurve(points: number[][]): number[] {
  const pts = points
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) throw new Error("LUT needs at least 2 control points");

  const n = STD_LUT_SIZE;
  const inMin = pts[0][0];
  const inMax = pts[pts.length - 1][0];
  const span = inMax - inMin || 1;
  const out = new Array<number>(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = inMin + (span * i) / (n - 1);
    while (seg < pts.length - 2 && x > pts[seg + 1][0]) seg++;
    const [x0, y0] = pts[seg];
    const [x1, y1] = pts[seg + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    out[i] = y0 + (y1 - y0) * t;
  }
  return out;
}

/** Normalize an arbitrary-scale table into [0,1]. */
function normalize(values: number[]): number[] {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  let denom = 1;
  if (max > 1.5) denom = max <= 255 ? 255 : max <= 4095 ? 4095 : max;
  return values.map((v) => Math.min(1, Math.max(0, v / denom)));
}

/** Linear-resample a curve to exactly `size` entries. */
function resample(values: number[], size: number): Float32Array {
  const out = new Float32Array(size);
  const n = values.length;
  if (n === size) {
    out.set(values);
    return out;
  }
  for (let i = 0; i < size; i++) {
    const pos = (i / (size - 1)) * (n - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(n - 1, i0 + 1);
    const t = pos - i0;
    out[i] = values[i0] + (values[i1] - values[i0]) * t;
  }
  return out;
}

function slugify(filename: string): string {
  return (
    "lut-" +
    filename
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function prettyName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}
