import {
  OUTPUT_MAX,
  type FilterEngine,
  type FilterParams,
  type FilterResult,
  type ImageBuffer,
} from "../types";
import type { Lut } from "../../luts/types";
import { computeAutoWindow, type Window } from "../windowing";
import { computeClaheMaps, sampleClahe, type ClaheMaps } from "../clahe";
import { windowedHistogram, otsu2, SEG_COLORS } from "../segmentation";

/**
 * CPU baseline — the same enhancement pipeline as the Babylon shader, as a
 * straight typed-array loop on the main thread. Stands in for the current
 * Fabric.js path (synchronous, main-thread). The benchmark reports the GPU
 * speedup against this number. Math is identical to shaders.ts.
 */
export class CpuFilterEngine implements FilterEngine {
  readonly name = "CPU (main thread)";
  backend = "JavaScript (no GPU)";

  private img: ImageBuffer | null = null;
  private luts = new Map<string, Float32Array>();
  private autoWin: Window = { center: 0, width: 1 };
  // CLAHE maps are expensive-ish to rebuild; cache them by the window+clip they
  // were computed for, so slider drags that don't touch the window stay cheap.
  private claheCache: { key: string; maps: ClaheMaps } | null = null;
  private otsuCache: { key: string; t1: number; t2: number } | null = null;

  isAvailable() {
    return true;
  }

  async init() {
    /* nothing to acquire */
  }

  async setImage(img: ImageBuffer) {
    this.img = { ...img, data: img.data.slice() };
    this.autoWin = computeAutoWindow(this.img.data, img.min, img.max);
    this.claheCache = null;
    this.otsuCache = null;
  }

  registerLut(lut: Lut) {
    this.luts.set(lut.id, lut.values.slice());
  }

  async run(params: FilterParams): Promise<FilterResult> {
    const img = this.img;
    if (!img) throw new Error("image not set");

    const { width: w, height: h, data } = img;
    const color = params.segEnabled && (params.segView === "map" || params.segTint);
    const comps: 1 | 3 = color ? 3 : 1;
    const out = new Float32Array(w * h * comps);

    const t0 = performance.now();

    // Base window: auto-fit (percentile) or DICOM default, then modulated by
    // the brightness/contrast sliders.
    const baseCenter = params.autoWindow ? this.autoWin.center : img.defaultCenter;
    const baseWidth = params.autoWindow ? this.autoWin.width : img.defaultWidth;
    const winCenter = baseCenter + params.brightness * baseWidth;
    const winWidth = baseWidth / (params.contrast <= 0 ? 1 : params.contrast) || 1;
    const winLow = winCenter - winWidth / 2;
    const invGamma = 1 / (params.gamma <= 0 ? 1 : params.gamma);
    const { denoise, sharpen, edge, invert } = params;

    // CLAHE maps (cached by window + clip). Applied inside the windowed sampler
    // so denoise/sharpen/edge all operate on the locally-equalized image.
    const claheAmt = params.clahe;
    let maps: ClaheMaps | null = null;
    if (claheAmt > 0) {
      const key = `${winLow}|${winWidth}|${params.claheClip}`;
      if (this.claheCache?.key !== key) {
        maps = computeClaheMaps(data, w, h, winLow, winWidth, params.claheClip);
        this.claheCache = { key, maps };
      } else {
        maps = this.claheCache.maps;
      }
    }

    // Tone-curve LUT lookup with linear interpolation (matches the GPU
    // texture's BILINEAR sampling). Undefined / "none" → identity.
    const lutValues =
      params.lut && params.lut !== "none" ? this.luts.get(params.lut) : undefined;
    const lutN = lutValues ? lutValues.length : 0;
    const applyLut = (v: number): number => {
      if (!lutValues) return v;
      const pos = v * (lutN - 1);
      const i0 = pos < 0 ? 0 : pos >= lutN - 1 ? lutN - 1 : Math.floor(pos);
      const i1 = i0 + 1 < lutN ? i0 + 1 : i0;
      const t = pos - i0;
      return lutValues[i0] + (lutValues[i1] - lutValues[i0]) * t;
    };

    // Tissue segmentation thresholds (Otsu auto, cached by window) + palette.
    let segT1 = params.segT1;
    let segT2 = params.segT2;
    if (params.segEnabled && params.segAuto) {
      const key = `${winLow}|${winWidth}`;
      if (this.otsuCache?.key !== key) {
        const r = otsu2(windowedHistogram(data, winLow, winWidth));
        this.otsuCache = { key, t1: r.t1, t2: r.t2 };
      }
      segT1 = this.otsuCache!.t1;
      segT2 = this.otsuCache!.t2;
    }
    const seg = params.segEnabled;
    const segF = params.segFeather;
    const ct = SEG_COLORS.tissue;
    const cb = SEG_COLORS.bone;
    const cn = SEG_COLORS.tooth;
    // Smoothstep matching GLSL: 0 below e0, 1 above e1, cubic between.
    const smooth = (e0: number, e1: number, x: number) => {
      let t = (x - e0) / (e1 - e0 || 1e-6);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      return t * t * (3 - 2 * t);
    };

    // Windowed, clamped 0..1 sample with edge clamping, then optional CLAHE
    // local-contrast mapping blended in by strength.
    const sample = (x: number, y: number) => {
      const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
      const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
      let v = (data[cy * w + cx] - winLow) / winWidth;
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      if (maps) {
        const eq = sampleClahe(maps, w, h, cx, cy, v);
        v = v + (eq - v) * claheAmt;
      }
      return v;
    };

    const invWidth = 1 / winWidth;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Windowed value WITHOUT CLAHE — the classification basis.
        let v0 = (data[y * w + x] - winLow) * invWidth;
        if (v0 < 0) v0 = 0;
        else if (v0 > 1) v0 = 1;

        const c = sample(x, y);
        const l = sample(x - 1, y);
        const r = sample(x + 1, y);
        const u = sample(x, y - 1);
        const d = sample(x, y + 1);
        const tl = sample(x - 1, y - 1);
        const tr = sample(x + 1, y - 1);
        const bl = sample(x - 1, y + 1);
        const br = sample(x + 1, y + 1);

        const blur = (c + l + r + u + d + tl + tr + bl + br) / 9;
        const base = c + (blur - c) * denoise;
        let v = base + sharpen * (c - blur);
        if (v < 0) v = 0;
        else if (v > 1) v = 1;

        v = Math.pow(v, invGamma);

        // tone-curve LUT (after gamma, before edge/invert — matches shader)
        v = applyLut(v);

        const gx = tr + 2 * r + br - (tl + 2 * l + bl);
        const gy = bl + 2 * d + br - (tl + 2 * u + tr);
        let e = Math.sqrt(gx * gx + gy * gy);
        if (e > 1) e = 1;
        v = v + (e - v) * edge;

        if (invert) v = 1 - v;

        // Tissue segmentation: per-class contrast/brightness + optional color.
        if (seg) {
          const aBone = smooth(segT1 - segF, segT1 + segF, v0);
          const aTooth = smooth(segT2 - segF, segT2 + segF, v0);
          const wTooth = aTooth;
          const wBone = aBone * (1 - aTooth);
          const wTissue = 1 - aBone;

          const gain =
            wTissue * params.segTissueGain +
            wBone * params.segBoneGain +
            wTooth * params.segToothGain;
          const bias = wTissue * params.segTissueBias + wTooth * params.segToothBias;
          v = (v - 0.5) * gain + 0.5 + bias;
          if (v < 0) v = 0;
          else if (v > 1) v = 1;

          if (color) {
            const rCls = wTissue * ct[0] + wBone * cb[0] + wTooth * cn[0];
            const gCls = wTissue * ct[1] + wBone * cb[1] + wTooth * cn[1];
            const bCls = wTissue * ct[2] + wBone * cb[2] + wTooth * cn[2];
            let rr: number, gg: number, bb: number;
            if (params.segView === "map") {
              const k = 0.35 + 0.65 * v;
              rr = rCls * k;
              gg = gCls * k;
              bb = bCls * k;
            } else {
              // tint: mix(white, class, 0.3) * v
              rr = v * (1 - 0.3 + 0.3 * rCls);
              gg = v * (1 - 0.3 + 0.3 * gCls);
              bb = v * (1 - 0.3 + 0.3 * bCls);
            }
            const o = (y * w + x) * 3;
            out[o] = rr * OUTPUT_MAX;
            out[o + 1] = gg * OUTPUT_MAX;
            out[o + 2] = bb * OUTPUT_MAX;
            continue;
          }
        }

        out[y * w + x] = v * OUTPUT_MAX;
      }
    }

    const elapsedMs = performance.now() - t0;
    return { data: out, width: w, height: h, components: comps, min: 0, max: OUTPUT_MAX, elapsedMs };
  }

  dispose() {
    this.img = null;
  }
}
