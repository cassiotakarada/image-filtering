import {
  WebGPUEngine,
  Scene,
  RawTexture,
  ProceduralTexture,
  Constants,
  Vector2,
  Color3,
} from "@babylonjs/core";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.js";
import glslangWasmUrl from "@babylonjs/core/assets/glslang/glslang.wasm?url";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.js";
import twgslWasmUrl from "@babylonjs/core/assets/twgsl/twgsl.wasm?url";
import { FILTER_FRAGMENT } from "./shaders";
import {
  OUTPUT_MAX,
  type FilterEngine,
  type FilterParams,
  type FilterResult,
  type ImageBuffer,
} from "../types";
import type { Lut } from "../../luts/types";
import { computeAutoWindow, type Window } from "../windowing";
import { computeClaheMaps, CLAHE_BINS, CLAHE_TILES, type ClaheMaps } from "../clahe";
import { windowedHistogram, otsu2, SEG_COLORS } from "../segmentation";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Babylon WebGPU filter engine — on the MAIN THREAD.
 *
 * Why not the worker (like the WebGL engine)? Our shader is GLSL; WebGPU needs
 * WGSL. Babylon transpiles GLSL→WGSL with the glslang/twgsl wasm, which it loads
 * via importScripts — unavailable in our module worker. Here we instead import
 * Babylon's bundled transpiler assets directly and pass the instances to
 * initAsync (no importScripts, no CDN). The emscripten wasm loader needs a
 * window, so this runs on the main thread. That's fine for benchmarking; it just
 * means WebGPU isn't off-main-thread here. Mirrors babylon.worker.ts exactly.
 *
 * Float textures aren't linearly filterable on WebGPU, so all textures (incl.
 * the LUT) use NEAREST sampling.
 */
export class BabylonWebGPUEngine implements FilterEngine {
  readonly name = "Babylon (WebGPU, main thread)";
  backend?: string;

  private engine: WebGPUEngine | null = null;
  private scene: Scene | null = null;
  private input: RawTexture | null = null;
  private proc: ProceduralTexture | null = null;
  private available = false;

  private readonly luts = new Map<string, RawTexture>();
  private identityLut: RawTexture | null = null;
  private dummyClahe: RawTexture | null = null;
  private claheTex: RawTexture | null = null;
  private claheKey = "";
  private otsuKey = "";
  private otsuT1 = 1 / 3;
  private otsuT2 = 2 / 3;

  private imgW = 0;
  private imgH = 0;
  private imgCenter = 0;
  private imgWidth = 1;
  private imgData: Float32Array | null = null;
  private autoWin: Window = { center: 0, width: 1 };

  isAvailable() {
    return this.available;
  }

  async init(): Promise<void> {
    try {
      const canvas = document.createElement("canvas");
      const engine = new WebGPUEngine(canvas, { antialias: false, stencil: false });
      // Preloaded transpiler instances → no importScripts, no CDN.
      const glslang = await glslangFactory(glslangWasmUrl);
      const twgsl = await twgslFactory(twgslWasmUrl);
      await engine.initAsync({ glslang }, { twgsl });
      this.engine = engine;
      this.scene = new Scene(engine);
      this.scene.autoClear = false;
      this.identityLut = this.makeLut(new Float32Array([0, 1]));
      this.dummyClahe = this.makeClahe(new Float32Array([0]), 1, 1);

      if (!(await this.probe())) {
        this.backend = "WebGPU (shader compile failed)";
        return;
      }
      this.available = true;
      this.backend = "WebGPU";
    } catch (e) {
      this.backend = "WebGPU (unavailable)";
      // Stay unavailable; never throw — the other engines must be unaffected.
      console.warn("[BabylonWebGPUEngine] unavailable:", e);
    }
  }

  private makeLut(values: Float32Array): RawTexture {
    const tex = RawTexture.CreateRTexture(
      values,
      values.length,
      1,
      this.scene as Scene,
      false,
      false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT
    );
    tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    return tex;
  }

  private makeClahe(values: Float32Array, bins: number, rows: number): RawTexture {
    const tex = RawTexture.CreateRTexture(
      values,
      bins,
      rows,
      this.scene as Scene,
      false,
      false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT
    );
    tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    return tex;
  }

  private async probe(): Promise<boolean> {
    if (!this.scene) return false;
    const probe = new ProceduralTexture(
      "probe",
      { width: 1, height: 1 },
      { fragmentSource: FILTER_FRAGMENT },
      this.scene,
      null,
      false,
      false,
      Constants.TEXTURETYPE_FLOAT
    );
    probe.refreshRate = 0;
    for (let i = 0; i < 400 && !probe.isReady(); i++) await sleep(2);
    const ok = probe.isReady();
    probe.dispose();
    return ok;
  }

  registerLut(lut: Lut): void {
    if (!this.scene) return;
    this.luts.get(lut.id)?.dispose();
    this.luts.set(lut.id, this.makeLut(lut.values.slice()));
  }

  async setImage(img: ImageBuffer): Promise<void> {
    if (!this.scene) return;
    this.imgW = img.width;
    this.imgH = img.height;
    this.imgCenter = img.defaultCenter;
    this.imgWidth = img.defaultWidth || 1;
    this.imgData = img.data.slice();
    this.autoWin = computeAutoWindow(this.imgData, img.min, img.max);
    this.claheKey = "";
    this.otsuKey = "";

    this.input?.dispose();
    this.input = RawTexture.CreateRTexture(
      this.imgData,
      this.imgW,
      this.imgH,
      this.scene,
      false,
      false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT
    );

    this.proc?.dispose();
    this.proc = new ProceduralTexture(
      "filter",
      { width: this.imgW, height: this.imgH },
      { fragmentSource: FILTER_FRAGMENT },
      this.scene,
      null,
      false,
      false,
      Constants.TEXTURETYPE_FLOAT
    );
    this.proc.refreshRate = 0;
    this.proc.setTexture("src", this.input);
  }

  async run(params: FilterParams): Promise<FilterResult> {
    const proc = this.proc;
    if (!proc || !this.input || !this.imgData) throw new Error("image not set");
    const { imgW, imgH, imgData } = this;

    const baseCenter = params.autoWindow ? this.autoWin.center : this.imgCenter;
    const baseWidth = params.autoWindow ? this.autoWin.width : this.imgWidth;
    const winCenter = baseCenter + params.brightness * baseWidth;
    const winWidth = baseWidth / (params.contrast <= 0 ? 1 : params.contrast) || 1;
    const winLow = winCenter - winWidth / 2;

    proc.setVector2("texel", new Vector2(1 / imgW, 1 / imgH));
    proc.setFloat("winLow", winLow);
    proc.setFloat("winWidth", winWidth);
    proc.setFloat("denoiseAmt", params.denoise);
    proc.setFloat("sharpenAmt", params.sharpen);
    proc.setFloat("edgeAmt", params.edge);
    proc.setFloat("gammaVal", params.gamma <= 0 ? 1 : params.gamma);
    proc.setFloat("invertFlag", params.invert ? 1 : 0);

    if (params.clahe > 0) {
      const key = `${winLow}|${winWidth}|${params.claheClip}`;
      if (key !== this.claheKey) {
        const maps: ClaheMaps = computeClaheMaps(
          imgData,
          imgW,
          imgH,
          winLow,
          winWidth,
          params.claheClip
        );
        this.claheTex?.dispose();
        this.claheTex = this.makeClahe(maps.maps, maps.bins, maps.tilesX * maps.tilesY);
        this.claheKey = key;
      }
      proc.setTexture("claheTex", this.claheTex!);
      proc.setFloat("claheFlag", 1);
      proc.setFloat("claheAmt", params.clahe);
      proc.setVector2("claheTilePx", new Vector2(imgW / CLAHE_TILES, imgH / CLAHE_TILES));
      proc.setVector2("claheGrid", new Vector2(CLAHE_TILES, CLAHE_TILES));
      proc.setFloat("claheBins", CLAHE_BINS);
      proc.setFloat("claheRows", CLAHE_TILES * CLAHE_TILES);
    } else {
      proc.setTexture("claheTex", this.dummyClahe!);
      proc.setFloat("claheFlag", 0);
      proc.setFloat("claheAmt", 0);
      proc.setVector2("claheTilePx", new Vector2(imgW, imgH));
      proc.setVector2("claheGrid", new Vector2(1, 1));
      proc.setFloat("claheBins", 1);
      proc.setFloat("claheRows", 1);
    }

    const lutTex = params.lut && params.lut !== "none" ? this.luts.get(params.lut) : undefined;
    proc.setTexture("lut", lutTex ?? this.identityLut!);
    proc.setFloat("lutFlag", lutTex ? 1 : 0);

    let t1 = params.segT1;
    let t2 = params.segT2;
    if (params.segEnabled && params.segAuto) {
      const key = `${winLow}|${winWidth}`;
      if (key !== this.otsuKey) {
        const r = otsu2(windowedHistogram(imgData, winLow, winWidth));
        this.otsuT1 = r.t1;
        this.otsuT2 = r.t2;
        this.otsuKey = key;
      }
      t1 = this.otsuT1;
      t2 = this.otsuT2;
    }
    proc.setFloat("segFlag", params.segEnabled ? 1 : 0);
    proc.setFloat("segT1", t1);
    proc.setFloat("segT2", t2);
    proc.setFloat("segFeather", params.segFeather);
    proc.setFloat("segTissueGain", params.segTissueGain);
    proc.setFloat("segTissueBias", params.segTissueBias);
    proc.setFloat("segBoneGain", params.segBoneGain);
    proc.setFloat("segToothGain", params.segToothGain);
    proc.setFloat("segToothBias", params.segToothBias);
    proc.setFloat("segView", params.segView === "map" ? 1 : 0);
    proc.setFloat("segTint", params.segTint ? 1 : 0);
    proc.setColor3("segColTissue", new Color3(...SEG_COLORS.tissue));
    proc.setColor3("segColBone", new Color3(...SEG_COLORS.bone));
    proc.setColor3("segColTooth", new Color3(...SEG_COLORS.tooth));

    proc.setFloat("outMax", OUTPUT_MAX);

    const color = params.segEnabled && (params.segView === "map" || params.segTint);

    for (let i = 0; i < 600 && !proc.isReady(); i++) await sleep(2);
    if (!proc.isReady()) throw new Error("filter shader failed to compile (WebGPU)");

    const t0 = performance.now();
    proc.render();
    const raw = (await proc.readPixels()) as Float32Array | null;
    const elapsedMs = performance.now() - t0;
    if (!raw) throw new Error("readPixels returned null");

    const n = imgW * imgH;
    let out: Float32Array;
    if (color) {
      out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        out[i * 3] = raw[i * 4];
        out[i * 3 + 1] = raw[i * 4 + 1];
        out[i * 3 + 2] = raw[i * 4 + 2];
      }
    } else {
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = raw[i * 4];
    }

    return {
      data: out,
      width: imgW,
      height: imgH,
      components: color ? 3 : 1,
      min: 0,
      max: OUTPUT_MAX,
      elapsedMs,
    };
  }

  dispose() {
    this.proc?.dispose();
    this.input?.dispose();
    this.luts.forEach((t) => t.dispose());
    this.luts.clear();
    this.scene?.dispose();
    this.engine?.dispose();
    this.engine = null;
    this.scene = null;
    this.available = false;
  }
}
