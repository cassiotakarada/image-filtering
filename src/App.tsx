import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BabylonDirectEngine,
  BabylonFilterEngine,
  BabylonWebGPUEngine,
  CpuFilterEngine,
  DEFAULT_FILTERS,
  FabricDisplay,
  liveModeDirectBackend,
  liveModeDisplay,
  liveModeOffscreenEngine,
  type DirectBackend,
  type EngineKind,
  type FilterEngine,
  type FilterParams,
  type ImageBuffer,
  type LiveMode,
} from "./engine";
import {
  benchDisplayImage,
  cornerstoneBackend,
  cornerstoneBenchProbeWebGPU,
  cornerstoneDicomLoaderError,
  decodeCompressedFiles,
  describeTransferSyntax,
  initCornerstone,
  initCornerstoneDicomLoader,
  loadDicomFileRaw,
  loadDicomFileViaCornerstone,
  loadImageBuffer,
  makeSourceImage,
  parseDicomFiles,
  purgeCornerstoneFileManager,
  registerFilteredResult,
  registerSlices,
  resizeCornerstoneViewport,
  setupViewport,
  showImage,
} from "./dicom";
import { Controls } from "./components/Controls";
import { BenchmarkPanel, type BenchRow } from "./components/BenchmarkPanel";
import { listLuts, addLut } from "./luts/registry";
import { loadLutFromFile } from "./luts/loadLut";
import { type Lut } from "./luts/types";
import { PRESETS, type Preset } from "./presets/presets";
import "./app.css";

const BENCH_SAMPLES = 7;

function isDefault(p: FilterParams) {
  return (
    p.brightness === 0 &&
    p.contrast === 1 &&
    p.denoise === 0 &&
    p.sharpen === 0 &&
    p.edge === 0 &&
    p.gamma === 1 &&
    !p.invert &&
    p.lut === "none" &&
    !p.segEnabled
  );
}

export default function App() {
  // Cornerstone's StackViewport widget — used when liveMode display routes
  // through Cornerstone (the original "behind a Cornerstone display seam"
  // architecture; still our integration path).
  const viewportRef = useRef<HTMLDivElement>(null);
  // Two Babylon canvases, one per backend. We can't share a single canvas
  // between WebGL and WebGPU contexts (they're mutually exclusive on a
  // canvas), and we want to avoid the ~100ms dispose+recreate hit on every
  // mode switch — so each backend has its own persistent canvas, with CSS
  // toggling visibility based on the active liveMode.
  const babylonWebGLCanvasRef = useRef<HTMLCanvasElement>(null);
  const babylonWebGPUCanvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * Separate offscreen-ish canvases used by the babylon-direct *bench rows*.
   * We can't reuse the visible direct-engine canvases above because (a) the
   * bench resizes the canvas to the loaded slice (clobbering the user's view)
   * and (b) running the bench would steal the GPU context. These bench
   * canvases live in the DOM (positioned off-screen via CSS) so Babylon can
   * attach a real WebGL / WebGPU context to them, but the user never sees
   * what gets drawn there.
   */
  const babylonWebGLBenchCanvasRef = useRef<HTMLCanvasElement>(null);
  const babylonWebGPUBenchCanvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * Visible canvas backing the live Fabric.js display for the
   * `babylon-cs-full-*` modes. One shared canvas (Fabric.js supports both
   * WebGL- and WebGPU-engine inputs identically — the display itself is a
   * 2D-context Fabric Canvas wrapping our blit canvas).
   *
   * Also a separate off-screen canvas for the bench rows, sized off-screen
   * for the same reason as the babylon bench canvases above.
   */
  const fabricCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricBenchCanvasRef = useRef<HTMLCanvasElement>(null);

  const engines = useRef<Record<EngineKind, FilterEngine> | null>(null);
  /**
   * Babylon engines that render DIRECTLY to a visible canvas (no readback,
   * no cornerstone display). Lazy-created on first use of the corresponding
   * babylon-canvas live mode; the canvas refs above are read at init time.
   * Once created, they're reused across slice/param/mode changes.
   */
  const directEngines = useRef<Record<DirectBackend, BabylonDirectEngine | null>>({
    webgl: null,
    webgpu: null,
  });
  /**
   * In-flight init promises so concurrent `ensureDirectEngine(backend)` calls
   * during a slow first-time init (especially WebGPU's ~500ms glslang/twgsl
   * load) all await the SAME engine instead of racing to create duplicates
   * on the same canvas (which would fail — only one context per canvas).
   */
  const directInitPromises = useRef<Record<DirectBackend, Promise<BabylonDirectEngine | null> | null>>({
    webgl: null,
    webgpu: null,
  });
  /**
   * Live FabricDisplay attached to the visible fabric canvas. Lazy-created
   * on first use of a babylon-cs-full-* mode; reused thereafter. One
   * instance is shared between the WebGL and WebGPU variants — the display
   * doesn't care which backend produced the filter pixels, only the
   * resulting Float32 buffer (passed via FilterResult).
   */
  const fabricDisplay = useRef<FabricDisplay | null>(null);
  /** True once we've at least *tried* to init the direct engine (success or
   *  failure). Mirrors `directEngines` keys; used by mode-availability.
   *  Defaults: WebGL is optimistically `true` (WebGL2 is near-universal);
   *  WebGPU starts `true` only if `navigator.gpu` exists. Init failures flip
   *  the flag to false with a reason; the radio enables the user to TRY a
   *  mode before its engine has been created. */
  const [directAvailable, setDirectAvailable] = useState<Record<DirectBackend, boolean>>(
    () => ({
      webgl: true,
      webgpu:
        typeof navigator !== "undefined" && "gpu" in navigator,
    })
  );

  const source = useRef<ImageBuffer | null>(null);
  const sourceId = useRef<string>("");
  const sliceIds = useRef<string[]>([]);
  /**
   * Source `File` handles aligned to `sliceIds` (so `sliceFiles.current[i]`
   * is the file that produced the slice at `sliceIds.current[i]`). The bench
   * needs the original File for the active slice to re-time open+parse on
   * every sample. Empty when running on the synthetic phantom.
   */
  const sliceFiles = useRef<File[]>([]);

  const [status, setStatus] = useState("Initializing…");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useState<FilterParams>(DEFAULT_FILTERS);
  /**
   * Active end-to-end pipeline configuration. Replaces the legacy 3-way
   * `engineKind`: one of nine values that map 1:1 to a benchmark row. See
   * `engine/index.ts` for the full enum. Defaults to the previous-favorite
   * cornerstone-display path so existing users see the same first frame.
   */
  const [liveMode, setLiveMode] = useState<LiveMode>("babylon-cs-full-webgl");
  /** Whether each offscreen filter engine came up successfully. */
  const [available, setAvailable] = useState<Record<EngineKind, boolean>>({
    babylon: false,
    webgpu: false,
    cpu: true,
  });
  /** Whether the cornerstone wadouri loader is usable (cs-* modes need it). */
  const [csLoaderReady, setCsLoaderReady] = useState(false);
  const [lastMs, setLastMs] = useState<Partial<Record<EngineKind | "direct-webgl" | "direct-webgpu", number>>>({});
  const [size, setSize] = useState(512);
  const [sliceCount, setSliceCount] = useState(0);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [bench, setBench] = useState<BenchRow[] | null>(null);
  /**
   * Description of the slice that produced the current bench numbers
   * (filename + dimensions), rendered in the BenchmarkPanel header so the
   * user can tell which file is being measured. Cleared on file/phantom
   * changes via `setBench(null)`.
   */
  const [benchSubject, setBenchSubject] = useState<string | null>(null);
  const [luts, setLuts] = useState<Lut[]>(listLuts());
  const [activePreset, setActivePreset] = useState<string>("original");

  // Push every known LUT into every engine (built-ins at init, loaded ones live).
  const registerLuts = useCallback((all: Lut[]) => {
    const e = engines.current;
    if (e) {
      for (const lut of all) {
        e.babylon.registerLut(lut);
        e.webgpu.registerLut(lut);
        e.cpu.registerLut(lut);
      }
    }
    const dw = directEngines.current.webgl;
    const dg = directEngines.current.webgpu;
    for (const lut of all) {
      dw?.registerLut(lut);
      dg?.registerLut(lut);
    }
  }, []);

  // ---- one-time init -------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    (async () => {
      await initCornerstone();
      if (disposed || !viewportRef.current) return;
      setupViewport(viewportRef.current);

      const babylon = new BabylonFilterEngine({
        backend: "webgl",
        name: "Babylon (WebGL, worker)",
      });
      const webgpu = new BabylonWebGPUEngine();
      const cpu = new CpuFilterEngine();
      engines.current = { babylon, webgpu, cpu };

      // Fire off the cs-wadouri loader init in the background so the
      // cs-* modes become available without blocking the visible viewport.
      // Failure is non-fatal — the affected modes just stay disabled.
      initCornerstoneDicomLoader().then((ok) => {
        if (!disposed) setCsLoaderReady(ok);
      });

      await Promise.allSettled([babylon.init(), webgpu.init(), cpu.init()]);

      // Built-in tone curves are available immediately after engines come up.
      registerLuts(listLuts());

      const { imageId } = makeSourceImage(size);
      sourceId.current = imageId;
      const src = await loadImageBuffer(imageId);
      source.current = src;

      await Promise.all([
        babylon.isAvailable() ? babylon.setImage(src) : Promise.resolve(),
        webgpu.isAvailable() ? webgpu.setImage(src) : Promise.resolve(),
        cpu.setImage(src),
      ]);
      await showImage(imageId);

      if (disposed) return;
      setAvailable({
        babylon: babylon.isAvailable(),
        webgpu: webgpu.isAvailable(),
        cpu: true,
      });
      // Pick a sensible default mode if the preferred one's underlying engine
      // didn't come up. Fallback order: babylon-cs-full-webgl →
      // babylon-cs-full-webgpu → cornerstone-webgl → cpu.
      if (!babylon.isAvailable()) {
        setLiveMode(webgpu.isAvailable() ? "babylon-cs-full-webgpu" : "cornerstone-webgl");
      }
      setReady(true);
      setStatus("Ready");
    })().catch((e) => setStatus("Init error: " + (e?.message ?? String(e))));
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Lazy-initialise a `BabylonDirectEngine` for the given backend. Idempotent
   * (no-op if already created and ready). Returns the engine or null on
   * failure. Both the bench and the live-view dispatcher use this so the
   * direct engines spin up exactly once per backend.
   *
   * Concurrent callers during a slow first-time init share the same promise
   * via `directInitPromises` — important for WebGPU, whose ~500ms glslang
   * load would otherwise race two engines onto the same canvas (and fail).
   *
   * Side effects on success: pushes all currently-registered LUTs into the
   * new engine, calls `setImage` with the active source so the next `run()`
   * paints something, and flips `directAvailable[backend]` for the mode
   * selector.
   */
  const ensureDirectEngine = useCallback(
    (backend: DirectBackend): Promise<BabylonDirectEngine | null> => {
      const inFlight = directInitPromises.current[backend];
      if (inFlight) return inFlight;
      const existing = directEngines.current[backend];
      if (existing && existing.isAvailable()) return Promise.resolve(existing);

      const promise = (async (): Promise<BabylonDirectEngine | null> => {
        const canvas =
          backend === "webgl"
            ? babylonWebGLCanvasRef.current
            : babylonWebGPUCanvasRef.current;
        if (!canvas) return null;
        const eng = new BabylonDirectEngine({ backend, canvas });
        await eng.init();
        if (!eng.isAvailable()) {
          setDirectAvailable((p) => ({ ...p, [backend]: false }));
          return null;
        }
        // Wire up LUTs and the current source so the engine is ready to draw.
        for (const lut of listLuts()) eng.registerLut(lut);
        if (source.current) await eng.setImage(source.current);
        directEngines.current[backend] = eng;
        setDirectAvailable((p) => ({ ...p, [backend]: true }));
        return eng;
      })().finally(() => {
        directInitPromises.current[backend] = null;
      });

      directInitPromises.current[backend] = promise;
      return promise;
    },
    []
  );

  /**
   * Lazy-initialise the live `FabricDisplay`. Idempotent. The display is
   * a thin wrapper around the visible fabric canvas — no GPU context to
   * worry about, just a 2D Canvas + Fabric Canvas pair, so we don't need
   * the in-flight-promise dance the direct engines use.
   */
  const ensureFabricDisplay = useCallback((): FabricDisplay | null => {
    if (fabricDisplay.current) return fabricDisplay.current;
    const canvas = fabricCanvasRef.current;
    if (!canvas) return null;
    const fd = new FabricDisplay(canvas);
    fd.init();
    fabricDisplay.current = fd;
    return fd;
  }, []);

  /**
   * Drive one render via the active `liveMode`. Four branches:
   *   - babylon-canvas display → ensure + drive the direct engine; the canvas
   *                              gets painted directly, no cornerstone.
   *   - fabric display + filter engine → existing offscreen-readback path,
   *                              hands the Float32 result to a Fabric.js
   *                              Canvas (CSOI-Web target flow). Used by
   *                              babylon-cs-full-* modes.
   *   - cornerstone display + filter engine → existing offscreen-readback
   *                              path, registers a `filtered:N` imageId and
   *                              hands it to cornerstone for display (cpu
   *                              row only after the babylon-cs-full-* split).
   *   - cornerstone display, no filter engine (cornerstone-webgl mode) →
   *                              just re-display the source through cornerstone;
   *                              brightness/contrast still affect VOI via the
   *                              source's `windowCenter`/`windowWidth` metadata,
   *                              but our shader filters are inactive.
   */
  const applyFilter = useCallback(async () => {
    try {
      const display = liveModeDisplay(liveMode);
      if (display === "unavailable") return;

      if (display === "babylon-canvas") {
        const backend = liveModeDirectBackend(liveMode)!;
        const eng = await ensureDirectEngine(backend);
        if (!eng) return;
        const res = await eng.run(params);
        setLastMs((prev) => ({
          ...prev,
          [`direct-${backend}` as const]: res.elapsedMs,
        }));
        return;
      }

      if (display === "fabric") {
        // Cornerstone parses → Babylon filters → Fabric displays.
        //
        // We use the *direct* Babylon engine (main thread, no worker)
        // here rather than the worker-offscreen engines used by the
        // cornerstone-display path. The direct engine renders straight
        // to its own canvas, and we `drawImage` that canvas into Fabric's
        // scratch — a GPU-side copy in the browser compositor. The
        // worker path would force a readPixels → Float32 → Uint8 RGBA
        // round trip (~60ms per frame at 1200×1400), which dominates the
        // bench and is unnecessary when the display sink is itself a
        // browser-side canvas.
        const backend = liveModeDirectBackend(liveMode);
        if (!backend) return;
        const eng = await ensureDirectEngine(backend);
        if (!eng || !eng.isAvailable()) return;
        const fd = ensureFabricDisplay();
        if (!fd) return;
        const res = await eng.run(params);
        setLastMs((prev) => ({
          ...prev,
          [`direct-${backend}` as const]: res.elapsedMs,
        }));
        fd.showFromCanvas(eng.canvas, eng.canvas.width, eng.canvas.height);
        return;
      }

      // display === "cornerstone"
      const offscreenKind = liveModeOffscreenEngine(liveMode);
      if (!offscreenKind) {
        // cornerstone-webgl: no babylon, just show the source via cornerstone.
        if (sourceId.current) await showImage(sourceId.current);
        return;
      }
      const eng = engines.current?.[offscreenKind];
      if (!eng || !eng.isAvailable()) return;
      const res = await eng.run(params);
      setLastMs((prev) => ({ ...prev, [offscreenKind]: res.elapsedMs }));
      const id = registerFilteredResult(res);
      await showImage(id);
    } catch (e) {
      setStatus("Filter error: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [liveMode, params, ensureDirectEngine, ensureFabricDisplay]);

  // ---- re-run on param / mode change (debounced) ---------------------------
  useEffect(() => {
    if (!ready) return;
    const h = setTimeout(applyFilter, 80);
    return () => clearTimeout(h);
  }, [ready, applyFilter]);

  // Load `id` as the active source into all engines (offscreen + direct).
  const activateSource = useCallback(async (id: string) => {
    sourceId.current = id;
    const src = await loadImageBuffer(id);
    source.current = src;
    const e = engines.current;
    const dw = directEngines.current.webgl;
    const dg = directEngines.current.webgpu;
    await Promise.all([
      e?.babylon.isAvailable() ? e.babylon.setImage(src) : Promise.resolve(),
      e?.webgpu.isAvailable() ? e.webgpu.setImage(src) : Promise.resolve(),
      e?.cpu.setImage(src) ?? Promise.resolve(),
      // Direct engines only get the new source if they've been created. They
      // get one on first ensureDirectEngine() if not yet.
      dw?.isAvailable() ? dw.setImage(src) : Promise.resolve(),
      dg?.isAvailable() ? dg.setImage(src) : Promise.resolve(),
    ]);
  }, []);

  // ---- synthetic phantom size change ---------------------------------------
  const regenerate = useCallback(
    async (newSize: number) => {
      setSize(newSize);
      setBusy(true);
      setStatus("Regenerating phantom…");
      try {
        sliceIds.current = [];
        sliceFiles.current = [];
        setSliceCount(0);
        const { imageId } = makeSourceImage(newSize);
        await activateSource(imageId);
        await showImage(imageId);
        setBench(null);
        setBenchSubject(null);
        setStatus("Ready");
      } catch (err) {
        setStatus("Resize error: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        setBusy(false);
      }
    },
    [activateSource]
  );

  // ---- load a real CT folder (parsed in-browser) ---------------------------
  const handleLoadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || !fileList.length) return;
      setBusy(true);
      setStatus(`Parsing ${fileList.length} files…`);
      try {
        const files = Array.from(fileList);
        const outcome = await parseDicomFiles(files, (done, total) => {
          if (done % 25 === 0 || done === total) setStatus(`Parsing ${done}/${total}…`);
        });

        let slices = outcome.slices;
        let sourceFiles = outcome.sourceFiles;
        const compressed = Object.keys(outcome.compressedSyntaxes).length > 0;
        if (compressed) {
          const names = Object.entries(outcome.compressedSyntaxes)
            .map(([uid, n]) => `${describeTransferSyntax(uid)} ×${n}`)
            .join("; ");
          setStatus(`Decoding compressed series (${names})…`);
          const decoded = await decodeCompressedFiles(files, (done, total) => {
            if (done % 10 === 0 || done === total) setStatus(`Decoding ${done}/${total}…`);
          });
          slices = decoded.slices;
          sourceFiles = decoded.sourceFiles;
        }

        if (!slices.length) {
          setStatus(
            `Could not decode any image. ${outcome.skippedOther} non-image files skipped.`
          );
          return;
        }
        const ids = registerSlices(slices);
        sliceIds.current = ids;
        // Keep the original File handles aligned to slice ids so the benchmark
        // can re-open the active slice's bytes on every sample (FR-008 etc.).
        sliceFiles.current = sourceFiles;
        setSliceCount(ids.length);
        const mid = Math.floor(ids.length / 2);
        setSliceIndex(mid);
        await activateSource(ids[mid]);
        await showImage(ids[mid]);
        setBench(null);
        setBenchSubject(null);
        const skipped = outcome.skippedCompressed
          ? ` — ${outcome.skippedCompressed} compressed slices skipped`
          : "";
        setStatus(`Loaded ${ids.length} slices${skipped}. Ready.`);
      } catch (err) {
        setStatus("Load error: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        setBusy(false);
      }
    },
    [activateSource]
  );

  const selectSlice = useCallback(
    async (i: number) => {
      const ids = sliceIds.current;
      if (!ids.length) return;
      const idx = Math.max(0, Math.min(ids.length - 1, i));
      setSliceIndex(idx);
      setBusy(true);
      try {
        await activateSource(ids[idx]);
        if (isDefault(params)) await showImage(ids[idx]);
        else await applyFilter();
      } finally {
        setBusy(false);
      }
    },
    [activateSource, params, applyFilter]
  );

  /**
   * "Show original": display the loaded slice with NO filter enhancements
   * applied (windowing-only). Mode-aware so the babylon-direct and fabric
   * modes paint an unfiltered frame to their canvas instead of falling
   * back to cornerstone (which would have nothing to display in those
   * modes).
   */
  const showOriginal = useCallback(async () => {
    const display = liveModeDisplay(liveMode);
    if (display === "babylon-canvas") {
      const backend = liveModeDirectBackend(liveMode)!;
      const eng = await ensureDirectEngine(backend);
      if (eng) await eng.run(DEFAULT_FILTERS);
      return;
    }
    if (display === "fabric") {
      // Mirror the applyFilter fabric branch: direct engine + drawImage.
      const backend = liveModeDirectBackend(liveMode);
      const eng = backend ? await ensureDirectEngine(backend) : null;
      const fd = ensureFabricDisplay();
      if (eng && eng.isAvailable() && fd) {
        await eng.run(DEFAULT_FILTERS);
        fd.showFromCanvas(eng.canvas, eng.canvas.width, eng.canvas.height);
      }
      return;
    }
    if (sourceId.current) await showImage(sourceId.current);
  }, [liveMode, ensureDirectEngine, ensureFabricDisplay]);

  // Apply a named preset ("favorite"): load its full param bundle + LUT.
  const applyPreset = useCallback((preset: Preset) => {
    setActivePreset(preset.id);
    setParams(preset.params);
  }, []);

  // Manual edits (sliders / LUT dropdown) leave the "preset" mode.
  const changeParams = useCallback((p: FilterParams) => {
    setActivePreset("");
    setParams(p);
  }, []);

  // Load a validated LUT file, register it into both engines, select it.
  const handleLoadLut = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || !fileList.length) return;
      try {
        for (const file of Array.from(fileList)) {
          const lut = await loadLutFromFile(file);
          addLut(lut);
          engines.current?.babylon.registerLut(lut);
          engines.current?.cpu.registerLut(lut);
          setLuts(listLuts());
          setActivePreset("");
          setParams((prev) => ({ ...prev, lut: lut.id }));
          setStatus(`Loaded LUT "${lut.name}".`);
        }
      } catch (err) {
        setStatus("LUT load error: " + (err instanceof Error ? err.message : String(err)));
      }
    },
    []
  );

  const runBenchmark = useCallback(async () => {
    const e = engines.current;
    if (!e) return;

    // End-to-end open+parse+render bench. Needs the original File for the
    // active slice to time the open + parse steps — phantom-mode (no folder
    // loaded) has no File, so we surface that as an empty bench instead of
    // running on whatever's in memory (which would skip "open" entirely).
    const file = sliceFiles.current[sliceIndex];
    if (!file) {
      setStatus(
        "Load a DICOM folder first — the end-to-end benchmark needs the original file bytes."
      );
      return;
    }

    setBusy(true);
    setStatus("Benchmarking…");

    // Try to spin up the Cornerstone wadouri loader. If it fails (Vite worker
    // hang etc.) the cs-* rows fall back to n/a with a reason.
    const csReady = await initCornerstoneDicomLoader();
    if (csReady !== csLoaderReady) setCsLoaderReady(csReady);
    purgeCornerstoneFileManager();

    // Bench-only direct engines. We create these lazily here (separate from
    // the live ones, which are attached to the user-visible canvases) so the
    // bench doesn't interfere with what's currently displayed.
    const benchDirect: Record<DirectBackend, BabylonDirectEngine | null> = {
      webgl: null,
      webgpu: null,
    };
    const ensureBenchDirect = async (
      backend: DirectBackend
    ): Promise<BabylonDirectEngine | null> => {
      if (benchDirect[backend]) return benchDirect[backend];
      const canvas =
        backend === "webgl"
          ? babylonWebGLBenchCanvasRef.current
          : babylonWebGPUBenchCanvasRef.current;
      if (!canvas) return null;
      const eng = new BabylonDirectEngine({ backend, canvas });
      await eng.init();
      if (!eng.isAvailable()) return null;
      for (const lut of listLuts()) eng.registerLut(lut);
      benchDirect[backend] = eng;
      return eng;
    };

    // Bench-only Fabric display — same reason as the bench direct engines:
    // the live FabricDisplay is attached to the visible canvas and would
    // both flicker its dimensions and steal the user's view if we drove it
    // from the bench. Lazy-created on first fabric row.
    //
    // Using a single-element ref-style object so the closure assignment in
    // `ensureBenchFabric` is visible to the cleanup code below — a bare
    // `let benchFabric: FabricDisplay | null = null` trips TS's control-flow
    // narrowing (it can't see the closure-side assignment and narrows the
    // type to `null` at the cleanup site).
    const benchFabricRef: { current: FabricDisplay | null } = { current: null };
    const ensureBenchFabric = (): FabricDisplay | null => {
      if (benchFabricRef.current) return benchFabricRef.current;
      const canvas = fabricBenchCanvasRef.current;
      if (!canvas) return null;
      const fd = new FabricDisplay(canvas);
      fd.init();
      benchFabricRef.current = fd;
      return fd;
    };

    // Per-row config drives one shared sampler below. Each row is one of
    // four flavours:
    //   - cornerstone-display + engine: parse → engine.run → registerFilteredResult → benchDisplayImage
    //   - cornerstone-display, no engine: parse via cs-wadouri → benchDisplayImage(parsedImageId)
    //   - fabric-display: parse → directEngine.setImage → directEngine.run → FabricDisplay.showFromCanvas
    //                     (drawImage from the direct engine's canvas → fabric scratch → backgroundImage;
    //                      no readPixels, no Float32 → Uint8 conversion — the CSOI-Web target flow)
    //   - babylon-direct: parse → directEngine.setImage → directEngine.run (paints to bench canvas)
    type LoadResult = { buffer: ImageBuffer; imageId?: string };
    type Display =
      | "cornerstone"
      | "direct-webgl"
      | "direct-webgpu"
      | "fabric";
    interface RowSpec {
      kind: BenchRow["kind"];
      name: string;
      parser: string;
      backend?: string;
      display: Display;
      load?: (file: File) => Promise<LoadResult>;
      eng?: FilterEngine; // for cornerstone-display + offscreen filter rows
    }

    const rawLoad = async (f: File): Promise<LoadResult> => ({
      buffer: await loadDicomFileRaw(f),
    });
    const csLoad = async (f: File): Promise<LoadResult> => {
      const r = await loadDicomFileViaCornerstone(f);
      return { buffer: r.buffer, imageId: r.imageId };
    };

    const csBackend = cornerstoneBackend();
    // 9 rows in fixed order (matches LIVE_MODE_ORDER 1:1).
    const specs: RowSpec[] = [
      {
        kind: "babylon-only-webgl",
        name: "Babylon-only (WebGL)",
        parser: "dicom-parser",
        backend: "Babylon WebGL (direct)",
        display: "direct-webgl",
        load: rawLoad,
      },
      {
        kind: "babylon-only-webgpu",
        name: "Babylon-only (WebGPU)",
        parser: "dicom-parser",
        backend: "Babylon WebGPU (direct)",
        display: "direct-webgpu",
        load: rawLoad,
      },
      {
        kind: "babylon-cs-full-webgl",
        name: "Babylon + CS + Fabric (WebGL)",
        parser: "Cornerstone wadouri",
        backend: "Babylon WebGL (direct)",
        display: "fabric",
        load: csLoad,
      },
      {
        kind: "babylon-cs-full-webgpu",
        name: "Babylon + CS + Fabric (WebGPU)",
        parser: "Cornerstone wadouri",
        backend: "Babylon WebGPU (direct)",
        display: "fabric",
        load: csLoad,
      },
      {
        kind: "babylon-cs-parse-webgl",
        name: "Babylon + CS parse only (WebGL)",
        parser: "Cornerstone wadouri",
        backend: "Babylon WebGL (direct)",
        display: "direct-webgl",
        load: csLoad,
      },
      {
        kind: "babylon-cs-parse-webgpu",
        name: "Babylon + CS parse only (WebGPU)",
        parser: "Cornerstone wadouri",
        backend: "Babylon WebGPU (direct)",
        display: "direct-webgpu",
        load: csLoad,
      },
      {
        kind: "cornerstone-webgl",
        name: "Cornerstone (WebGL)",
        parser: "Cornerstone wadouri",
        backend: csBackend,
        display: "cornerstone",
        load: csLoad,
        // No engine — display the cornerstone-loaded imageId directly.
      },
      {
        kind: "cornerstone-webgpu",
        name: "Cornerstone (WebGPU)",
        parser: "Cornerstone wadouri",
        display: "cornerstone",
        // Filled in below from cornerstoneBenchProbeWebGPU — permanent n/a.
      },
      {
        kind: "cpu",
        name: "CPU (JavaScript)",
        parser: "dicom-parser",
        backend: e.cpu.backend,
        display: "cornerstone",
        load: rawLoad,
        eng: e.cpu,
      },
    ];

    // One sample of one row: open + parse + (engine render or direct paint) +
    // display. Returns ms wall-clock from `t0` to "pixels visible":
    //   - cornerstone-display rows wait for IMAGE_RENDERED on the bench viewport
    //   - fabric-display rows wait for FabricDisplay.showFromCanvas (which
    //     synchronously drawImages the direct engine's canvas, installs the
    //     new backgroundImage, and calls renderAll; the next browser
    //     composite paints the result, so this is comparable in wall-clock
    //     terms to the babylon-direct "endFrame submits" point)
    //   - babylon-direct rows wait for engine.run() to resolve (Babylon's
    //     endFrame submits the present; the very next composite step is
    //     comparable to IMAGE_RENDERED in wall-clock terms).
    const runOneSample = async (spec: RowSpec): Promise<number> => {
      const t0 = performance.now();
      const { buffer, imageId: parsedId } = await spec.load!(file);

      if (spec.display === "cornerstone") {
        let displayId: string;
        if (spec.eng) {
          await spec.eng.setImage(buffer);
          const r = await spec.eng.run(DEFAULT_FILTERS);
          displayId = registerFilteredResult(r);
        } else if (parsedId) {
          displayId = parsedId;
        } else {
          throw new Error("cornerstone row has neither engine nor parsed imageId");
        }
        await benchDisplayImage(displayId);
        return performance.now() - t0;
      }

      if (spec.display === "fabric") {
        // Same engine as the babylon-direct rows (BabylonDirectEngine on
        // a hidden bench canvas). We measure the cost of "render with
        // Babylon + drawImage into Fabric" — i.e. the CSOI-Web flow if it
        // adopted Babylon for filtering. The Float32 → Uint8 readback path
        // used by the offscreen worker engines is intentionally NOT here:
        // it was the dominant cost in the previous fabric flow.
        const backend: DirectBackend =
          spec.kind === "babylon-cs-full-webgl" ? "webgl" : "webgpu";
        const eng = await ensureBenchDirect(backend);
        if (!eng) throw new Error(`bench direct-${backend} engine unavailable`);
        const fd = ensureBenchFabric();
        if (!fd) throw new Error("bench fabric display unavailable");
        await eng.setImage(buffer);
        await eng.run(DEFAULT_FILTERS);
        fd.showFromCanvas(eng.canvas, eng.canvas.width, eng.canvas.height);
        return performance.now() - t0;
      }

      // Babylon-direct row: paint to the bench canvas, no readback.
      const backend: DirectBackend =
        spec.display === "direct-webgl" ? "webgl" : "webgpu";
      const eng = await ensureBenchDirect(backend);
      if (!eng) throw new Error(`direct-${backend} engine unavailable`);
      await eng.setImage(buffer);
      await eng.run(DEFAULT_FILTERS);
      return performance.now() - t0;
    };

    const rows: BenchRow[] = [];
    for (const spec of specs) {
      // Cornerstone WebGPU is a permanent placeholder (no implementation).
      if (spec.kind === "cornerstone-webgpu") {
        const probe = cornerstoneBenchProbeWebGPU();
        rows.push({
          kind: spec.kind,
          name: spec.name,
          parser: spec.parser,
          ms: null,
          backend: probe.backend,
          note: probe.note,
        });
        continue;
      }

      // Offscreen filter engine unavailable → n/a row.
      if (spec.eng && !spec.eng.isAvailable()) {
        rows.push({
          kind: spec.kind,
          name: spec.name,
          parser: spec.parser,
          ms: null,
          backend: spec.backend,
          note: "engine unavailable",
        });
        continue;
      }

      // Cornerstone-parsed rows need the wadouri loader to be initialised.
      if (spec.parser === "Cornerstone wadouri" && !csReady) {
        rows.push({
          kind: spec.kind,
          name: spec.name,
          parser: spec.parser,
          ms: null,
          backend: spec.backend,
          note: cornerstoneDicomLoaderError() ?? "Cornerstone DICOM loader unavailable",
        });
        continue;
      }

      // Probe direct-engine availability ahead of timing so we can show a
      // friendlier "n/a" reason than a thrown sample.
      if (spec.display !== "cornerstone") {
        const backend: DirectBackend =
          spec.display === "direct-webgl" ? "webgl" : "webgpu";
        const probe = await ensureBenchDirect(backend);
        if (!probe) {
          rows.push({
            kind: spec.kind,
            name: spec.name,
            parser: spec.parser,
            ms: null,
            backend: spec.backend,
            note: `${backend.toUpperCase()} not available`,
          });
          continue;
        }
      }

      try {
        setStatus(`Benchmarking ${spec.name} · ${spec.parser}…`);
        // Warmup sample (discarded). On the first run a row pays for codec
        // worker spawn, shader compile, cache priming, etc. — discarding it
        // keeps the median representative of steady-state cost.
        await runOneSample(spec);
        const times: number[] = [];
        for (let i = 0; i < BENCH_SAMPLES; i++) {
          times.push(await runOneSample(spec));
        }
        times.sort((a, b) => a - b);
        rows.push({
          kind: spec.kind,
          name: spec.name,
          parser: spec.parser,
          ms: times[Math.floor(times.length / 2)],
          backend: spec.backend,
        });
      } catch (err) {
        rows.push({
          kind: spec.kind,
          name: spec.name,
          parser: spec.parser,
          ms: null,
          backend: spec.backend,
          note: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tear down bench-only direct engines so their GPU contexts free up.
    for (const k of ["webgl", "webgpu"] as DirectBackend[]) {
      benchDirect[k]?.dispose();
      benchDirect[k] = null;
    }
    // Dispose the bench fabric display too (releases the Fabric Canvas
    // and the scratch canvas it held).
    benchFabricRef.current?.dispose();
    benchFabricRef.current = null;

    // Restore the user's viewport (the bench changed what the offscreen
    // viewport was showing, but the visible one is unaffected; we still
    // re-display the active slice so timings/displays stay consistent).
    if (source.current) {
      try {
        await activateSource(sourceId.current);
        if (isDefault(params)) await showImage(sourceId.current);
        else await applyFilter();
      } catch {
        /* non-fatal — the bench numbers are still good */
      }
    }

    purgeCornerstoneFileManager();
    setBench(rows);
    setBenchSubject(
      `${file.name} · ${source.current?.width ?? "?"}×${source.current?.height ?? "?"}`
    );
    setBusy(false);
    setStatus("Ready");
  }, [params, sliceIndex, activateSource, applyFilter, csLoaderReady]);

  // What's currently on the screen? Drives CSS visibility of the three
  // viewport widgets (cornerstone div, babylon WebGL canvas, babylon WebGPU
  // canvas). Computed each render from the active liveMode so toggling a
  // radio swaps the view without any imperative show/hide code.
  const activeDisplay = liveModeDisplay(liveMode);
  const activeDirectBackend = liveModeDirectBackend(liveMode);

  // Re-size Cornerstone's internal canvas when the cs viewport becomes
  // visible. The cs widget might be `display:none` at init time (if the
  // default live mode is a non-cornerstone one), in which case
  // `setupViewport` enabled the element while it had a 0\u00d70 box \u2014 the
  // canvas drawing buffer defaulted to 300\u00d7150 and CSS scaled it to fill
  // the visible square, distorting the image. The `requestAnimationFrame`
  // tick lets layout settle after the .hidden class flips before we ask
  // Cornerstone to measure the new size.
  useEffect(() => {
    if (activeDisplay !== "cornerstone") return;
    const raf = requestAnimationFrame(() => resizeCornerstoneViewport());
    return () => cancelAnimationFrame(raf);
  }, [activeDisplay]);

  /**
   * Computed per-mode availability snapshot, fed to `Controls` so the right
   * radios are disabled and `BenchmarkPanel` knows which "Use" buttons to
   * grey out. A mode is "available" when every piece of its pipeline is up:
   *   - parser (cs-wadouri loader for cs-* modes; always available for raw)
   *   - filter engine, if any (BabylonFilterEngine / BabylonWebGPUEngine /
   *     CpuFilterEngine for the cs-full and cpu rows)
   *   - direct engine, if any (BabylonDirectEngine for the babylon-canvas rows)
   */
  const modeAvailable = useMemo<Record<LiveMode, boolean>>(() => {
    const csLoader = csLoaderReady;
    return {
      "babylon-only-webgl": directAvailable.webgl,
      "babylon-only-webgpu": directAvailable.webgpu,
      // -cs-full-* now uses the BabylonDirectEngine (not the worker
      // offscreen engines), so it gates on directAvailable, not available.
      "babylon-cs-full-webgl": directAvailable.webgl && csLoader,
      "babylon-cs-full-webgpu": directAvailable.webgpu && csLoader,
      "babylon-cs-parse-webgl": directAvailable.webgl && csLoader,
      "babylon-cs-parse-webgpu": directAvailable.webgpu && csLoader,
      "cornerstone-webgl": csLoader,
      "cornerstone-webgpu": false,
      cpu: true,
    };
  }, [available, csLoaderReady, directAvailable]);

  const modeUnavailableReason = useMemo<Partial<Record<LiveMode, string>>>(() => {
    const reasons: Partial<Record<LiveMode, string>> = {};
    if (!csLoaderReady) {
      reasons["babylon-cs-full-webgl"] = "needs CS DICOM loader";
      reasons["babylon-cs-full-webgpu"] = "needs CS DICOM loader";
      reasons["babylon-cs-parse-webgl"] = "needs CS DICOM loader";
      reasons["babylon-cs-parse-webgpu"] = "needs CS DICOM loader";
      reasons["cornerstone-webgl"] = "needs CS DICOM loader";
    }
    if (!directAvailable.webgl) {
      reasons["babylon-only-webgl"] = "WebGL init failed";
      reasons["babylon-cs-parse-webgl"] = "WebGL init failed";
      // -cs-full-* now uses the direct engine too \u2014 same availability gate.
      reasons["babylon-cs-full-webgl"] = "WebGL init failed";
    }
    if (!directAvailable.webgpu) {
      // Differentiate "browser has no WebGPU at all" from "init failed".
      const noWebGPU =
        typeof navigator === "undefined" || !("gpu" in navigator);
      const note = noWebGPU ? "no WebGPU in this browser" : "WebGPU init failed";
      reasons["babylon-only-webgpu"] = note;
      reasons["babylon-cs-parse-webgpu"] = note;
      reasons["babylon-cs-full-webgpu"] = note;
    }
    reasons["cornerstone-webgpu"] = "no WebGPU backend in CS3D 4.x";
    return reasons;
  }, [csLoaderReady, directAvailable]);

  return (
    <div className="app">
      <header>
        <h1>Babylon Filter Spike</h1>
        <p className="sub">
          GPU filter engine behind a Cornerstone3D display seam · CSOI-Web
          proof-of-concept
        </p>
      </header>

      <main>
        <section className="viewer-col">
          <div className={`viewport-wrap display-${activeDisplay}`}>
            {/*
              Four overlapping viewport widgets — only one is shown at a time
              via CSS based on .display-{cornerstone|babylon-canvas|fabric|
              unavailable} on the wrapper. We keep all of them mounted (and
              keep their GPU/2D contexts alive) so mode switches are instant.
            */}
            <div
              ref={viewportRef}
              className={`viewport viewport-cs${
                activeDisplay === "cornerstone" ? "" : " hidden"
              }`}
            />
            <canvas
              ref={babylonWebGLCanvasRef}
              className={`viewport viewport-babylon${
                activeDirectBackend === "webgl" ? "" : " hidden"
              }`}
            />
            <canvas
              ref={babylonWebGPUCanvasRef}
              className={`viewport viewport-babylon${
                activeDirectBackend === "webgpu" ? "" : " hidden"
              }`}
            />
            <canvas
              ref={fabricCanvasRef}
              className={`viewport viewport-fabric${
                activeDisplay === "fabric" ? "" : " hidden"
              }`}
            />
          </div>
          <div className="statusbar">
            <span className={ready ? "ok" : "pending"}>{status}</span>
            <span className="timings">
              {(["babylon", "webgpu", "cpu"] as EngineKind[]).map((k) =>
                lastMs[k] != null ? (
                  <code key={k}>
                    {k}: {lastMs[k]!.toFixed(1)}ms
                  </code>
                ) : null
              )}
              {lastMs["direct-webgl"] != null ? (
                <code>direct-webgl: {lastMs["direct-webgl"]!.toFixed(1)}ms</code>
              ) : null}
              {lastMs["direct-webgpu"] != null ? (
                <code>direct-webgpu: {lastMs["direct-webgpu"]!.toFixed(1)}ms</code>
              ) : null}
            </span>
          </div>
        </section>

        <aside className="side-col">
          <Controls
            params={params}
            onChange={changeParams}
            liveMode={liveMode}
            onModeChange={setLiveMode}
            modeAvailable={modeAvailable}
            modeUnavailableReason={modeUnavailableReason}
            size={size}
            onSizeChange={regenerate}
            onLoadFiles={handleLoadFiles}
            sliceCount={sliceCount}
            sliceIndex={sliceIndex}
            onSliceChange={selectSlice}
            onShowOriginal={showOriginal}
            onBenchmark={runBenchmark}
            presets={PRESETS}
            activePreset={activePreset}
            onApplyPreset={applyPreset}
            luts={luts}
            onLoadLut={handleLoadLut}
            busy={busy || !ready}
          />
          <BenchmarkPanel
            rows={bench}
            samples={BENCH_SAMPLES}
            subject={benchSubject}
            liveMode={liveMode}
            onUseMode={setLiveMode}
            busy={busy || !ready}
          />
        </aside>
      </main>

      {/*
        Hidden bench-only canvases. They live in the DOM (positioned
        off-screen via CSS) so Babylon can attach real WebGL/WebGPU contexts
        to them and Fabric can attach its 2D-canvas wrapper, but the user
        never sees what gets drawn. Used exclusively by runBenchmark() for
        the babylon-direct rows (babylon canvases) and the babylon-cs-full-*
        rows (fabric canvas).
      */}
      <canvas ref={babylonWebGLBenchCanvasRef} className="bench-canvas" aria-hidden />
      <canvas ref={babylonWebGPUBenchCanvasRef} className="bench-canvas" aria-hidden />
      <canvas ref={fabricBenchCanvasRef} className="bench-canvas" aria-hidden />
    </div>
  );
}
