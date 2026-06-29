/// <reference lib="webworker" />
/**
 * Babylon filter engine — worker side.
 *
 * Runs entirely off the main thread on an OffscreenCanvas, so slider drags
 * never block React / Cornerstone. The source image is uploaded once as an
 * R32F RawTexture (native bit depth, no 8-bit round-trip); each run() sets
 * uniforms, renders one ProceduralTexture pass on the GPU, and reads the
 * result back exactly once.
 *
 * NOTE: imports the @babylonjs/core barrel on purpose — for a spike it
 * guarantees every shader/side-effect is registered. Production should switch
 * to deep `@babylonjs/core/...` imports for tree-shaking (see README).
 */
import {
  Engine,
  WebGPUEngine,
  Scene,
  RawTexture,
  ProceduralTexture,
  Constants,
  Vector2,
} from "@babylonjs/core";
import { FILTER_FRAGMENT } from "./shaders";
import { OUTPUT_MAX, type FilterParams } from "../types";
import { computeAutoWindow, type Window } from "../windowing";
import { computeClaheMaps, CLAHE_BINS, CLAHE_TILES, type ClaheMaps } from "../clahe";
import { windowedHistogram, otsu2, SEG_COLORS } from "../segmentation";
import {
  Color3,
} from "@babylonjs/core";
import type { FromWorker, ToWorker } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let engine: Engine | WebGPUEngine | null = null;
let useWebGPU = false;
// Float textures are not linearly *filterable* on WebGPU without an optional
// feature, so the LUT (the only linear-sampled float texture) drops to NEAREST
// there. WebGL keeps bilinear. Set when the engine is created.
let lutSampling = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
let scene: Scene | null = null;
let input: RawTexture | null = null;
let proc: ProceduralTexture | null = null;

// Tone-curve LUTs, uploaded once each as width=N, height=1 R32F textures and
// bound per-run by id. `identity` is always present so the sampler is never
// left unbound (we toggle application with the lutFlag uniform instead).
const luts = new Map<string, RawTexture>();
let identityLut: RawTexture | null = null;

let imgW = 0;
let imgH = 0;
let imgCenter = 0;
let imgWidth = 1;
// CPU-side copy of the source, needed to compute the histogram-based auto window
// and the CLAHE tile maps (the GPU only ever sees textures).
let imgData: Float32Array | null = null;
let autoWin: Window = { center: 0, width: 1 };

// CLAHE map texture, cached by the (window + clip) it was built for so repeated
// runs with the same window (e.g. the benchmark loop) don't rebuild it.
let claheTex: RawTexture | null = null;
let claheKey = "";
let dummyClahe: RawTexture | null = null;

// Otsu thresholds, cached by the window they were computed for.
let otsuKey = "";
let otsuT1 = 1 / 3;
let otsuT2 = 2 / 3;

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

async function ensureEngine() {
  if (engine) return;
  const canvas = new OffscreenCanvas(1, 1);
  if (useWebGPU) {
    // WebGPU init is async and transpiles our GLSL to WGSL (Babylon fetches
    // twgsl). Throws if WebGPU is unavailable — caller turns that into an
    // "unavailable" engine so the rest of the benchmark is unaffected.
    const e = new WebGPUEngine(canvas as unknown as HTMLCanvasElement, {
      antialias: false,
      stencil: false,
    });
    await e.initAsync();
    engine = e;
    lutSampling = Constants.TEXTURE_NEAREST_SAMPLINGMODE;
  } else {
    engine = new Engine(
      canvas,
      false,
      { preserveDrawingBuffer: false, stencil: false },
      false
    );
    lutSampling = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
  }
  scene = new Scene(engine as Engine);
  scene.autoClear = false;

  // Identity fallback so the `lut` sampler is always bound.
  identityLut = makeLutTexture(new Float32Array([0, 1]));
  // 1x1 placeholder so the `claheTex` sampler is always bound when CLAHE is off.
  dummyClahe = makeClaheTexture(new Float32Array([0]), 1, 1);
}

/** Build the per-tile CLAHE map texture (bins × rows), NEAREST-sampled. */
function makeClaheTexture(values: Float32Array, bins: number, rows: number): RawTexture {
  if (!scene) throw new Error("scene not initialised");
  const tex = RawTexture.CreateRTexture(
    values,
    bins,
    rows,
    scene,
    false,
    false,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE, // exact bins/rows; we lerp bins in-shader
    Constants.TEXTURETYPE_FLOAT
  );
  tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return tex;
}

/** Build a 1-D (Nx1) float texture for a tone curve, with linear filtering. */
function makeLutTexture(values: Float32Array): RawTexture {
  if (!scene) throw new Error("scene not initialised");
  const tex = RawTexture.CreateRTexture(
    values,
    values.length,
    1,
    scene as Scene,
    false,
    false,
    lutSampling, // bilinear on WebGL, nearest on WebGPU (float not filterable)
    Constants.TEXTURETYPE_FLOAT
  );
  tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return tex;
}

function buildPipeline(data: Float32Array) {
  if (!scene) throw new Error("scene not initialised");

  input?.dispose();
  input = RawTexture.CreateRTexture(
    data,
    imgW,
    imgH,
    scene,
    false,
    false,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_FLOAT
  );

  proc?.dispose();
  proc = new ProceduralTexture(
    "filter",
    { width: imgW, height: imgH },
    { fragmentSource: FILTER_FRAGMENT },
    scene,
    null,
    false,
    false,
    Constants.TEXTURETYPE_FLOAT
  );
  proc.refreshRate = 0; // we render manually, once per run()
  proc.setTexture("src", input);
  // Pre-register every uniform/sampler the shader uses BEFORE the first
  // isReady() call. Babylon's ProceduralTexture builds the GLSL/WGSL uniforms
  // list from `_uniforms` / `_samplers` at compile time, and any name added
  // later (i.e. inside handleRun) becomes a silent no-op when render() tries
  // to upload it. Placeholder values are overwritten in handleRun.
  proc.setTexture("lut", identityLut!);
  proc.setTexture("claheTex", dummyClahe!);
  proc.setVector2("texel", new Vector2(1 / imgW, 1 / imgH));
  proc.setFloat("winLow", 0);
  proc.setFloat("winWidth", 1);
  proc.setFloat("denoiseAmt", 0);
  proc.setFloat("sharpenAmt", 0);
  proc.setFloat("edgeAmt", 0);
  proc.setFloat("gammaVal", 1);
  proc.setFloat("invertFlag", 0);
  proc.setFloat("claheFlag", 0);
  proc.setFloat("claheAmt", 0);
  proc.setVector2("claheTilePx", new Vector2(imgW, imgH));
  proc.setVector2("claheGrid", new Vector2(1, 1));
  proc.setFloat("claheBins", 1);
  proc.setFloat("claheRows", 1);
  proc.setFloat("lutFlag", 0);
  proc.setFloat("segFlag", 0);
  proc.setFloat("segT1", 0);
  proc.setFloat("segT2", 0);
  proc.setFloat("segFeather", 0);
  proc.setFloat("segTissueGain", 1);
  proc.setFloat("segTissueBias", 0);
  proc.setFloat("segBoneGain", 1);
  proc.setFloat("segToothGain", 1);
  proc.setFloat("segToothBias", 0);
  proc.setFloat("segView", 0);
  proc.setFloat("segTint", 0);
  proc.setColor3("segColTissue", new Color3(...SEG_COLORS.tissue));
  proc.setColor3("segColBone", new Color3(...SEG_COLORS.bone));
  proc.setColor3("segColTooth", new Color3(...SEG_COLORS.tooth));
  proc.setFloat("outMax", OUTPUT_MAX);
}

/**
 * Compile-probe the filter shader once (used for WebGPU). Our shader is GLSL;
 * WebGPU needs WGSL, and Babylon's GLSL→WGSL transpiler (twgsl/glslang) loads
 * via importScripts, which doesn't work in a module worker — so the shader
 * never becomes ready. Detect that here so the engine reports itself unavailable
 * cleanly instead of throwing on the first run().
 */
async function probeShaderReady(): Promise<boolean> {
  if (!scene) return false;
  const probe = new ProceduralTexture(
    "probe",
    { width: 1, height: 1 },
    { fragmentSource: FILTER_FRAGMENT },
    scene,
    null,
    false,
    false,
    Constants.TEXTURETYPE_FLOAT
  );
  probe.refreshRate = 0;
  for (let i = 0; i < 400 && !probe.isReady(); i++) await sleep(2);
  const ready = probe.isReady();
  probe.dispose();
  return ready;
}

function uploadClahe(maps: ClaheMaps) {
  claheTex?.dispose();
  claheTex = makeClaheTexture(maps.maps, maps.bins, maps.tilesX * maps.tilesY);
}

async function handleRun(id: number, params: FilterParams) {
  if (!proc || !input) throw new Error("image not set");

  // -------------------------------------------------------------------------
  // Per-stage timing (spec 002, contracts/stage-breakdown.md C-1):
  //   t_run_start  → t_after_isReady  → t_after_uniforms
  //                → t_after_render   → t_after_readPixels
  // compile = isReady wait (0 when warm). upload = uniform setters + CLAHE/LUT.
  // compute = proc.render() only. readback = await proc.readPixels().
  // elapsedMs = compile + upload + compute + readback (constitution Principle
  // IV: exactly one readPixels per run; no extra gl.finish() / GPU syncs).
  // -------------------------------------------------------------------------
  const tRunStart = performance.now();

  // compile: one-time shader compile happens here. Polling is async-await so a
  // not-yet-ready shader yields control rather than blocking the worker.
  for (let i = 0; i < 600 && !proc.isReady(); i++) await sleep(2);
  if (!proc.isReady())
    throw new Error(
      `filter shader failed to compile (${useWebGPU ? "WebGPU" : "WebGL"})`
    );
  const tAfterIsReady = performance.now();

  // Base window: auto-fit (percentile) or DICOM default, then slider-modulated.
  const baseCenter = params.autoWindow ? autoWin.center : imgCenter;
  const baseWidth = params.autoWindow ? autoWin.width : imgWidth;
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

  // CLAHE: (re)build the per-tile map texture for this window+clip if needed,
  // then bind it. The bilinear tile interpolation happens in the shader.
  if (params.clahe > 0 && imgData) {
    const key = `${winLow}|${winWidth}|${params.claheClip}`;
    if (key !== claheKey) {
      const maps = computeClaheMaps(imgData, imgW, imgH, winLow, winWidth, params.claheClip);
      uploadClahe(maps);
      claheKey = key;
    }
    proc.setTexture("claheTex", claheTex!);
    proc.setFloat("claheFlag", 1);
    proc.setFloat("claheAmt", params.clahe);
    proc.setVector2("claheTilePx", new Vector2(imgW / CLAHE_TILES, imgH / CLAHE_TILES));
    proc.setVector2("claheGrid", new Vector2(CLAHE_TILES, CLAHE_TILES));
    proc.setFloat("claheBins", CLAHE_BINS);
    proc.setFloat("claheRows", CLAHE_TILES * CLAHE_TILES);
  } else {
    proc.setTexture("claheTex", dummyClahe!);
    proc.setFloat("claheFlag", 0);
    proc.setFloat("claheAmt", 0);
    proc.setVector2("claheTilePx", new Vector2(imgW, imgH));
    proc.setVector2("claheGrid", new Vector2(1, 1));
    proc.setFloat("claheBins", 1);
    proc.setFloat("claheRows", 1);
  }

  // Bind the selected tone curve (or identity) and toggle its application.
  const lutTex = params.lut && params.lut !== "none" ? luts.get(params.lut) : undefined;
  proc.setTexture("lut", lutTex ?? identityLut!);
  proc.setFloat("lutFlag", lutTex ? 1 : 0);

  // Tissue segmentation thresholds (Otsu auto, cached by window) + per-class.
  let t1 = params.segT1;
  let t2 = params.segT2;
  if (params.segEnabled && params.segAuto && imgData) {
    const key = `${winLow}|${winWidth}`;
    if (key !== otsuKey) {
      const hist = windowedHistogram(imgData, winLow, winWidth);
      const r = otsu2(hist);
      otsuT1 = r.t1;
      otsuT2 = r.t2;
      otsuKey = key;
    }
    t1 = otsuT1;
    t2 = otsuT2;
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

  // Color output only when a color visualization is on (class-map or tint);
  // otherwise R=G=B and we read a single channel as before.
  const color = params.segEnabled && (params.segView === "map" || params.segTint);
  const tAfterUniforms = performance.now();

  proc.render();
  const tAfterRender = performance.now();

  const raw = (await proc.readPixels()) as Float32Array | null;
  const tAfterReadPixels = performance.now();
  if (!raw) throw new Error("readPixels returned null");

  const compile = tAfterIsReady - tRunStart;
  const upload = tAfterUniforms - tAfterIsReady;
  const compute = tAfterRender - tAfterUniforms;
  const readback = tAfterReadPixels - tAfterRender;
  const elapsedMs = tAfterReadPixels - tRunStart;

  // Output is RGBA float. Grayscale: R=G=B, pull one channel. Color: pull RGB.
  // CPU unpacking is intentionally OUTSIDE the timed region (contract C-1
  // "readback excludes the CPU-side un-interleave loop").
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

  post(
    {
      type: "result",
      id,
      width: imgW,
      height: imgH,
      components: color ? 3 : 1,
      min: 0,
      max: OUTPUT_MAX,
      elapsedMs,
      data: out,
      stages: { compile, upload, compute, readback },
    },
    [out.buffer]
  );
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "init": {
        useWebGPU = msg.backend === "webgpu";
        try {
          await ensureEngine();
        } catch (e) {
          post({
            type: "initError",
            message:
              (useWebGPU ? "WebGPU unavailable: " : "WebGL init failed: ") +
              (e instanceof Error ? e.message : String(e)),
          });
          break;
        }
        // WebGPU: confirm our GLSL shader actually compiles (it can't, in a
        // module worker, without the WGSL transpiler). Fail cleanly if not.
        if (useWebGPU && !(await probeShaderReady())) {
          post({
            type: "initError",
            message:
              "WebGPU: GLSL filter shader could not be transpiled to WGSL in a " +
              "module worker (twgsl/glslang needs importScripts). Would need a " +
              "native WGSL shader.",
          });
          break;
        }
        // Report the actual graphics backend so the benchmark proves which API
        // each engine got (WebGL2 vs WebGPU), not just a claim.
        let backend = useWebGPU ? "WebGPU" : "WebGL";
        let renderer: string | undefined;
        try {
          if (!useWebGPU && engine && "webGLVersion" in engine) {
            backend = `WebGL${(engine as Engine).webGLVersion}`;
            renderer = (engine as Engine).getGlInfo()?.renderer;
          }
        } catch {
          /* getGlInfo may be unavailable in some contexts */
        }
        post({ type: "ready", backend, renderer });
        break;
      }

      case "setImage": {
        await ensureEngine();
        imgW = msg.width;
        imgH = msg.height;
        imgCenter = msg.defaultCenter;
        imgWidth = msg.defaultWidth || 1;
        buildPipeline(msg.data);
        // Keep the CPU copy for histogram-based auto-window + CLAHE maps.
        imgData = msg.data;
        autoWin = computeAutoWindow(imgData, msg.min, msg.max);
        claheKey = ""; // invalidate CLAHE cache for the new image
        post({ type: "imageSet" });
        break;
      }

      case "setLut": {
        await ensureEngine();
        luts.get(msg.id)?.dispose();
        luts.set(msg.id, makeLutTexture(msg.values));
        break;
      }

      case "run":
        await handleRun(msg.id, msg.params);
        break;
    }
  } catch (err) {
    post({
      type: "error",
      id: "id" in msg ? (msg as { id?: number }).id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
