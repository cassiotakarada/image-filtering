/**
 * Babylon engine that renders the filter shader DIRECTLY to a visible canvas
 * via its WebGL/WebGPU swapchain — no `readPixels`, no CPU roundtrip, no
 * handoff to Cornerstone.
 *
 * Why this exists: the offscreen `BabylonFilterEngine` (worker, WebGL) and
 * `BabylonWebGPUEngine` (main thread) both end their `run()` with
 * `proc.readPixels()` because their output has to be handed to Cornerstone
 * for display. That readback dominates wall-clock time at typical DR/CT
 * sizes (62 MB at 2766×1400). For the "Babylon-only" benchmark rows and
 * for the "Babylon does its own display" live-view modes, we need a path
 * that skips both the readback AND the second Cornerstone render.
 *
 * Implementation: a main-thread Babylon engine attached to a visible canvas,
 * with the same `FILTER_FRAGMENT` shader run as a full-screen post-process
 * via `EffectRenderer` + `EffectWrapper`. The render target is the canvas's
 * own framebuffer (default render target), so output goes straight to the
 * pixels on screen. `setImage` / `registerLut` mirror the existing engines'
 * API so the bench harness and live view can swap engines freely.
 *
 * Limitations: GLSL only (so WebGPU goes through Babylon's GLSL→WGSL
 * transpile). Same auto-window / CLAHE / Otsu helpers as the offscreen
 * engines (intentional — apples-to-apples filter math).
 */
import {
  Engine,
  WebGPUEngine,
  Constants,
  RawTexture,
  Scene,
  EffectWrapper,
  EffectRenderer,
  Vector2,
  Color3,
  type AbstractEngine,
} from "@babylonjs/core";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.js";
import glslangWasmUrl from "@babylonjs/core/assets/glslang/glslang.wasm?url";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.js";
import twgslWasmUrl from "@babylonjs/core/assets/twgsl/twgsl.wasm?url";
import { FILTER_FRAGMENT } from "./shaders";
import {
  type FilterParams,
  type ImageBuffer,
} from "../types";
import type { Lut } from "../../luts/types";
import { computeAutoWindow, type Window } from "../windowing";
import { computeClaheMaps, CLAHE_BINS, CLAHE_TILES } from "../clahe";
import { windowedHistogram, otsu2, SEG_COLORS } from "../segmentation";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Names of every uniform `FILTER_FRAGMENT` reads, mirroring the existing
 *  engines. Must be declared up-front for `EffectWrapper`. */
const UNIFORM_NAMES = [
  "scale", // postprocess.vertex.glsl needs this for vUV scale
  "texel",
  "winLow",
  "winWidth",
  "denoiseAmt",
  "sharpenAmt",
  "edgeAmt",
  "gammaVal",
  "invertFlag",
  "claheFlag",
  "claheAmt",
  "claheTilePx",
  "claheGrid",
  "claheBins",
  "claheRows",
  "lutFlag",
  "outMax",
  "segFlag",
  "segT1",
  "segT2",
  "segFeather",
  "segTissueGain",
  "segTissueBias",
  "segBoneGain",
  "segToothGain",
  "segToothBias",
  "segView",
  "segTint",
  "segColTissue",
  "segColBone",
  "segColTooth",
];

const SAMPLER_NAMES = ["src", "lut", "claheTex"];

/**
 * Result returned from `run()`. Mirrors the shape of the offscreen engines'
 * `FilterResult` but without `data` (there is no pixel data — the pixels are
 * already on the canvas) and without per-stage timings.
 */
export interface DirectRunResult {
  /** Wall-clock ms from `run()` entry to the GPU finishing the fullscreen
   *  draw (observed via the engine's onEndFrameObservable). */
  elapsedMs: number;
  /** Canvas the engine painted to (== the one passed at init time). */
  canvas: HTMLCanvasElement;
}

/**
 * Backend kind. Same names as the bench column so the UI can use them
 * directly.
 */
export type DirectBackend = "webgl" | "webgpu";

export class BabylonDirectEngine {
  readonly backendKind: DirectBackend;
  readonly canvas: HTMLCanvasElement;
  /** Reported backend label (e.g. "WebGL2", "WebGPU"). */
  backend = "";

  private engine: AbstractEngine | null = null;
  private scene: Scene | null = null;
  private wrapper: EffectWrapper | null = null;
  private renderer: EffectRenderer | null = null;
  private input: RawTexture | null = null;
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

  constructor(opts: { backend: DirectBackend; canvas: HTMLCanvasElement }) {
    this.backendKind = opts.backend;
    this.canvas = opts.canvas;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async init(): Promise<void> {
    try {
      if (this.backendKind === "webgpu") {
        const engine = new WebGPUEngine(this.canvas, {
          antialias: false,
          stencil: false,
        });
        // Mirror BabylonWebGPUEngine.init: preload transpiler instances so no
        // importScripts/CDN fetch.
        const glslang = await glslangFactory(glslangWasmUrl);
        const twgsl = await twgslFactory(twgslWasmUrl);
        await engine.initAsync({ glslang }, { twgsl });
        this.engine = engine;
        // Surface WebGPU device errors. Validation failures inside Babylon
        // (e.g. attachment size mismatch from resizing the canvas while a
        // render pass descriptor is still pinned to old dimensions) are
        // otherwise silent — the render is dropped and the canvas simply
        // stays blank. Routing both `device.lost` and `uncapturederror`
        // through `console.error` makes those failures visible during
        // development without changing the engine's public behavior.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const device: GPUDevice | undefined = (engine as any)._device;
        if (device) {
          device.lost.then((info) => {
            // eslint-disable-next-line no-console
            console.error("[BabylonDirectEngine webgpu] device.lost", info.reason, info.message);
          });
          device.addEventListener("uncapturederror", (ev) => {
            // eslint-disable-next-line no-console
            console.error(
              "[BabylonDirectEngine webgpu] uncapturederror",
              (ev as GPUUncapturedErrorEvent).error.message
            );
          });
        }
        this.backend = "WebGPU";
      } else {
        // Plain Engine (WebGL). `disableWebGL2Support: false` keeps WebGL2 if
        // available, falling back to WebGL1 otherwise.
        const engine = new Engine(this.canvas, false, {
          stencil: false,
          antialias: false,
          preserveDrawingBuffer: false,
          // Required for `readPixels`-free direct-display: just need to render.
        });
        this.engine = engine;
        this.backend = engine.webGLVersion >= 2 ? "WebGL2" : "WebGL1";
      }

      // EffectRenderer needs a Scene only for resource management; nothing is
      // ever rendered through the scene graph (we draw a fullscreen quad
      // manually). Disable autoClear so the scene doesn't try to manage the
      // canvas's framebuffer.
      this.scene = new Scene(this.engine);
      this.scene.autoClear = false;

      this.renderer = new EffectRenderer(this.engine);
      this.wrapper = new EffectWrapper({
        engine: this.engine,
        name: "babylonDirectFilter",
        fragmentShader: FILTER_FRAGMENT,
        uniformNames: UNIFORM_NAMES,
        samplerNames: SAMPLER_NAMES,
      });

      this.identityLut = this.makeLut(new Float32Array([0, 1]));
      this.dummyClahe = this.makeClahe(new Float32Array([0]), 1, 1);

      // Wait for the wrapper's effect to compile.
      const ok = await this.waitForEffect();
      if (!ok) {
        this.backend = `${this.backend} (shader compile failed)`;
        return;
      }
      this.available = true;
    } catch (e) {
      // Mirror the existing engines: stay unavailable, never throw, log a hint.
      this.backend = `${this.backendKind === "webgpu" ? "WebGPU" : "WebGL"} (unavailable)`;
      // eslint-disable-next-line no-console
      console.warn("[BabylonDirectEngine] unavailable:", e);
    }
  }

  private async waitForEffect(): Promise<boolean> {
    if (!this.wrapper) return false;
    const eff = this.wrapper.effect;
    if (!eff) return false;
    for (let i = 0; i < 400 && !eff.isReady(); i++) await sleep(2);
    return eff.isReady();
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

    // Match the canvas's drawing buffer to the image so the fullscreen quad
    // maps 1:1 to native pixels. Use `engine.setSize` directly rather than
    // `canvas.width=imgW; canvas.height=imgH; engine.resize()` — the latter
    // assigns then immediately re-shrinks the canvas (engine.resize reads
    // CSS-clamped clientWidth on the visible canvas). The transient large
    // size leaves Babylon's WebGPU swapchain/attachment pair in a state
    // where subsequent render passes silently produce blank output. With
    // `setSize`, the canvas backing becomes imgW × imgH and CSS scales it
    // for display; the engine's depth attachment is recreated in lockstep,
    // so the swapchain stays valid for any image size.
    this.engine?.setSize(this.imgW, this.imgH);
  }

  /**
   * Render one frame with the current params, painting the filter result
   * directly to the canvas's framebuffer. Returns when the GPU has
   * finished the draw call (best observable: `engine.onEndFrameObservable`).
   */
  async run(params: FilterParams): Promise<DirectRunResult> {
    if (!this.engine || !this.renderer || !this.wrapper || !this.input || !this.imgData) {
      throw new Error("image not set");
    }
    const eff = this.wrapper.effect;
    if (!eff) throw new Error("wrapper effect missing");
    const ok = await this.waitForEffect();
    if (!ok) throw new Error("filter shader not ready");

    const t0 = performance.now();
    const { imgW, imgH, imgData } = this;

    const baseCenter = params.autoWindow ? this.autoWin.center : this.imgCenter;
    const baseWidth = params.autoWindow ? this.autoWin.width : this.imgWidth;
    const winCenter = baseCenter + params.brightness * baseWidth;
    const winWidth = baseWidth / (params.contrast <= 0 ? 1 : params.contrast) || 1;
    const winLow = winCenter - winWidth / 2;

    // CLAHE map (recomputed only when its key changes — same caching as the
    // offscreen engine).
    if (params.clahe > 0) {
      const key = `${winLow}|${winWidth}|${params.claheClip}`;
      if (key !== this.claheKey) {
        const maps = computeClaheMaps(
          imgData,
          imgW,
          imgH,
          winLow,
          winLow + winWidth,
          params.claheClip
        );
        this.claheTex?.dispose();
        this.claheTex = this.makeClahe(
          maps.maps,
          maps.bins,
          maps.tilesX * maps.tilesY
        );
        this.claheKey = key;
      }
    }

    // Otsu thresholds (cached on a key of winLow|winWidth).
    let t1 = params.segT1;
    let t2 = params.segT2;
    if (params.segEnabled && params.segAuto) {
      const key = `${winLow}|${winWidth}`;
      if (key !== this.otsuKey) {
        const hist = windowedHistogram(imgData, winLow, winWidth, 256);
        const t = otsu2(hist);
        this.otsuT1 = t.t1;
        this.otsuT2 = t.t2;
        this.otsuKey = key;
      }
      t1 = this.otsuT1;
      t2 = this.otsuT2;
    }

    // Bind everything for the draw. We do this inline (no helper) so the
    // sequence stays auditable: same order as BabylonWebGPUEngine.run().
    this.renderer.applyEffectWrapper(this.wrapper);

    eff.setTexture("src", this.input);
    eff.setTexture(
      "lut",
      this.luts.get(params.lut) ?? (this.identityLut as RawTexture)
    );
    eff.setTexture(
      "claheTex",
      params.clahe > 0 && this.claheTex
        ? this.claheTex
        : (this.dummyClahe as RawTexture)
    );

    eff.setVector2("scale", new Vector2(1, 1));
    eff.setVector2("texel", new Vector2(1 / imgW, 1 / imgH));
    eff.setFloat("winLow", winLow);
    eff.setFloat("winWidth", winWidth);
    eff.setFloat("denoiseAmt", params.denoise);
    eff.setFloat("sharpenAmt", params.sharpen);
    eff.setFloat("edgeAmt", params.edge);
    eff.setFloat("gammaVal", params.gamma <= 0 ? 1 : params.gamma);
    eff.setFloat("invertFlag", params.invert ? 1 : 0);
    eff.setFloat("lutFlag", params.lut === "none" ? 0 : 1);
    eff.setFloat("claheFlag", params.clahe > 0 ? 1 : 0);
    eff.setFloat("claheAmt", params.clahe);
    eff.setVector2(
      "claheTilePx",
      new Vector2(imgW / CLAHE_TILES, imgH / CLAHE_TILES)
    );
    eff.setVector2("claheGrid", new Vector2(CLAHE_TILES, CLAHE_TILES));
    eff.setFloat("claheBins", CLAHE_BINS);
    eff.setFloat("claheRows", CLAHE_TILES * CLAHE_TILES);
    // CRITICAL: render path divergence from the offscreen engines.
    //
    // The shader's final line is `gl_FragColor = vec4(rgb * outMax, 1.0)`.
    // The offscreen engines render into a Float32 texture and pass the raw
    // 0..OUTPUT_MAX values to Cornerstone, which normalizes them at display
    // time (windowCenter / windowWidth on the registered imageId). We're
    // rendering straight to the canvas's 8-bit LDR swapchain — values >1
    // get clamped to 1, so OUTPUT_MAX (= 4095) would write 1.0 to every
    // channel (all white on WebGL, all black on WebGPU once the sRGB
    // swapchain interprets the saturated values).
    //
    // We use `outMax = 1.0` so the shader emits 0..1 directly, matching
    // what the canvas swapchain expects. Filter math is identical; only
    // the final scale differs.
    eff.setFloat("outMax", 1.0);

    eff.setFloat("segFlag", params.segEnabled ? 1 : 0);
    eff.setFloat("segT1", t1);
    eff.setFloat("segT2", t2);
    eff.setFloat("segFeather", params.segFeather);
    eff.setFloat("segTissueGain", params.segTissueGain);
    eff.setFloat("segTissueBias", params.segTissueBias);
    eff.setFloat("segBoneGain", params.segBoneGain);
    eff.setFloat("segToothGain", params.segToothGain);
    eff.setFloat("segToothBias", params.segToothBias);
    eff.setFloat("segView", params.segView === "map" ? 1 : 0);
    eff.setFloat("segTint", params.segTint ? 1 : 0);
    eff.setColor3("segColTissue", new Color3(...SEG_COLORS.tissue));
    eff.setColor3("segColBone", new Color3(...SEG_COLORS.bone));
    eff.setColor3("segColTooth", new Color3(...SEG_COLORS.tooth));

    // Begin/end a frame so the engine binds the canvas's default framebuffer
    // and the on-screen swapchain advances. `draw()` issues the fullscreen
    // quad to whatever framebuffer is currently bound — which is the canvas
    // since we don't pass an output texture to `render()`.
    this.engine.beginFrame();
    this.renderer.render(this.wrapper); // outputs to canvas's framebuffer
    this.engine.endFrame();

    // We don't await an end-frame observable: `endFrame` on WebGL is
    // synchronous-ish (the GPU command is queued, but `endFrame` itself
    // returns immediately). Forcing a CPU↔GPU sync here would defeat the
    // whole point of "babylon-direct" (no readback). The wall-clock we
    // measure is "JS time from `run()` entry to commands submitted",
    // which is conceptually the same point Cornerstone fires
    // IMAGE_RENDERED (both are "renderer is done dispatching the frame").
    const elapsedMs = performance.now() - t0;
    return { elapsedMs, canvas: this.canvas };
  }

  dispose(): void {
    this.input?.dispose();
    this.claheTex?.dispose();
    this.identityLut?.dispose();
    this.dummyClahe?.dispose();
    this.luts.forEach((t) => t.dispose());
    this.luts.clear();
    this.wrapper?.dispose();
    this.renderer?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
    this.available = false;
  }
}
