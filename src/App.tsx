import { useCallback, useEffect, useRef, useState } from "react";
import {
  BabylonFilterEngine,
  BabylonWebGPUEngine,
  CpuFilterEngine,
  DEFAULT_FILTERS,
  type EngineKind,
  type FilterEngine,
  type FilterParams,
  type ImageBuffer,
} from "./engine";
import {
  cornerstoneBackend,
  cornerstoneBenchProbeWebGPU,
  cornerstoneBenchRenderWebGL,
  cornerstoneBenchSetSourceWebGL,
  decodeCompressedFiles,
  describeTransferSyntax,
  initCornerstone,
  loadImageBuffer,
  makeSourceImage,
  parseDicomFiles,
  registerFilteredResult,
  registerSlices,
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const engines = useRef<Record<EngineKind, FilterEngine> | null>(null);
  const source = useRef<ImageBuffer | null>(null);
  const sourceId = useRef<string>("");
  const sliceIds = useRef<string[]>([]);

  const [status, setStatus] = useState("Initializing…");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useState<FilterParams>(DEFAULT_FILTERS);
  const [engineKind, setEngineKind] = useState<EngineKind>("babylon");
  const [available, setAvailable] = useState<Record<EngineKind, boolean>>({
    babylon: false,
    webgpu: false,
    cpu: true,
  });
  const [lastMs, setLastMs] = useState<Partial<Record<EngineKind, number>>>({});
  const [size, setSize] = useState(512);
  const [sliceCount, setSliceCount] = useState(0);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [bench, setBench] = useState<BenchRow[] | null>(null);
  const [luts, setLuts] = useState<Lut[]>(listLuts());
  const [activePreset, setActivePreset] = useState<string>("original");

  // Push every known LUT into both engines (built-ins at init, loaded ones live).
  const registerLuts = useCallback((all: Lut[]) => {
    const e = engines.current;
    if (!e) return;
    for (const lut of all) {
      e.babylon.registerLut(lut);
      e.webgpu.registerLut(lut);
      e.cpu.registerLut(lut);
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
      if (!babylon.isAvailable()) setEngineKind(webgpu.isAvailable() ? "webgpu" : "cpu");
      setReady(true);
      setStatus("Ready");
    })().catch((e) => setStatus("Init error: " + (e?.message ?? String(e))));
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = useCallback(async () => {
    const eng = engines.current?.[engineKind];
    if (!eng || !eng.isAvailable()) return;
    try {
      const res = await eng.run(params);
      setLastMs((prev) => ({ ...prev, [engineKind]: res.elapsedMs }));
      const id = registerFilteredResult(res);
      await showImage(id);
    } catch (e) {
      setStatus("Filter error: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [engineKind, params]);

  // ---- re-run on param / engine change (debounced) -------------------------
  useEffect(() => {
    if (!ready) return;
    const h = setTimeout(applyFilter, 80);
    return () => clearTimeout(h);
  }, [ready, applyFilter]);

  // Load `id` as the active source into all engines.
  const activateSource = useCallback(async (id: string) => {
    sourceId.current = id;
    const src = await loadImageBuffer(id);
    source.current = src;
    const e = engines.current;
    if (e) {
      await Promise.all([
        e.babylon.isAvailable() ? e.babylon.setImage(src) : Promise.resolve(),
        e.webgpu.isAvailable() ? e.webgpu.setImage(src) : Promise.resolve(),
        e.cpu.setImage(src),
      ]);
    }
  }, []);

  // ---- synthetic phantom size change ---------------------------------------
  const regenerate = useCallback(
    async (newSize: number) => {
      setSize(newSize);
      setBusy(true);
      setStatus("Regenerating phantom…");
      try {
        sliceIds.current = [];
        setSliceCount(0);
        const { imageId } = makeSourceImage(newSize);
        await activateSource(imageId);
        await showImage(imageId);
        setBench(null);
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
        const compressed = Object.keys(outcome.compressedSyntaxes).length > 0;
        if (compressed) {
          const names = Object.entries(outcome.compressedSyntaxes)
            .map(([uid, n]) => `${describeTransferSyntax(uid)} ×${n}`)
            .join("; ");
          setStatus(`Decoding compressed series (${names})…`);
          slices = await decodeCompressedFiles(files, (done, total) => {
            if (done % 10 === 0 || done === total) setStatus(`Decoding ${done}/${total}…`);
          });
        }

        if (!slices.length) {
          setStatus(
            `Could not decode any image. ${outcome.skippedOther} non-image files skipped.`
          );
          return;
        }
        const ids = registerSlices(slices);
        sliceIds.current = ids;
        setSliceCount(ids.length);
        const mid = Math.floor(ids.length / 2);
        setSliceIndex(mid);
        await activateSource(ids[mid]);
        await showImage(ids[mid]);
        setBench(null);
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

  const showOriginal = useCallback(async () => {
    if (sourceId.current) await showImage(sourceId.current);
  }, []);

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
    setBusy(true);
    setStatus("Benchmarking…");

    // Time each engine into a keyed map; assemble the final rows array in the
    // locked backend-grouped order from contracts/benchmark-rows.md C-2.
    // This guarantees VR-1 (one of each kind) and VR-2 (order) regardless of
    // which engines succeed. Warmup-discard + BENCH_SAMPLES median sampling
    // is preserved for every timed row (FR-010).
    const engineRows: Partial<Record<EngineKind, BenchRow>> = {};
    const order: EngineKind[] = ["babylon", "webgpu", "cpu"];
    for (const k of order) {
      const eng = e[k];
      if (!eng.isAvailable()) {
        engineRows[k] = { kind: k, name: eng.name, ms: null, backend: eng.backend };
        continue;
      }
      try {
        const times: number[] = [];
        for (let i = 0; i < BENCH_SAMPLES; i++) {
          const r = await eng.run(params);
          times.push(r.elapsedMs);
        }
        times.sort((a, b) => a - b);
        engineRows[k] = {
          kind: k,
          name: eng.name,
          ms: times[Math.floor(times.length / 2)],
          backend: eng.backend,
        };
      } catch (err) {
        // One engine failing (e.g. WebGPU shader) must not abort the benchmark.
        engineRows[k] = {
          kind: k,
          name: eng.name,
          ms: null,
          backend: eng.backend,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Cornerstone (WebGL) — the "do I even need Babylon?" baseline. Windowing
    // only; mapped from the same brightness/contrast. Always emits a row
    // (real ms on success, n/a + note on failure) per FR-006 / C-3.
    let cornerstoneWebGLRow: BenchRow;
    if (source.current) {
      try {
        const { center, width } = await cornerstoneBenchSetSourceWebGL(source.current);
        const winCenter = center + params.brightness * width;
        const winWidth = width / (params.contrast <= 0 ? 1 : params.contrast) || 1;
        await cornerstoneBenchRenderWebGL(winCenter, winWidth, 0); // warmup (discarded)
        const times: number[] = [];
        for (let i = 0; i < BENCH_SAMPLES; i++) {
          const ms = await cornerstoneBenchRenderWebGL(winCenter, winWidth, i % 2);
          if (isFinite(ms)) times.push(ms);
        }
        times.sort((a, b) => a - b);
        cornerstoneWebGLRow = {
          kind: "cornerstone-webgl",
          name: "Cornerstone (WebGL)",
          ms: times.length ? times[Math.floor(times.length / 2)] : null,
          note: "windowing only",
          backend: cornerstoneBackend(),
        };
      } catch (err) {
        cornerstoneWebGLRow = {
          kind: "cornerstone-webgl",
          name: "Cornerstone (WebGL)",
          ms: null,
          note: err instanceof Error ? err.message : "unavailable",
          backend: cornerstoneBackend(),
        };
      }
    } else {
      cornerstoneWebGLRow = {
        kind: "cornerstone-webgl",
        name: "Cornerstone (WebGL)",
        ms: null,
        note: "no source loaded",
        backend: cornerstoneBackend(),
      };
    }

    // Cornerstone (WebGPU) — permanent placeholder. Cornerstone3D 4.15 has no
    // WebGPU backend (see specs/001-cornerstone-engines/research.md R1), so
    // this row is always n/a with a documented reason note (FR-007, FR-007a,
    // FR-012, C-9). No rendering, no viewport, no GPU resources allocated.
    const wgpuProbe = cornerstoneBenchProbeWebGPU();
    const cornerstoneWebGPURow: BenchRow = {
      kind: "cornerstone-webgpu",
      name: "Cornerstone (WebGPU)",
      ms: null,
      note: wgpuProbe.note,
      backend: wgpuProbe.backend,
    };

    // Assemble in locked C-2 order: backend-grouped, CPU last.
    const rows: BenchRow[] = [
      engineRows.babylon!,
      cornerstoneWebGLRow,
      engineRows.webgpu!,
      cornerstoneWebGPURow,
      engineRows.cpu!,
    ];

    setBench(rows);
    setBusy(false);
    setStatus("Ready");
  }, [params]);

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
          <div className="viewport-wrap">
            <div ref={viewportRef} className="viewport" />
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
            </span>
          </div>
        </section>

        <aside className="side-col">
          <Controls
            params={params}
            onChange={changeParams}
            engineKind={engineKind}
            onEngineChange={setEngineKind}
            available={available}
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
          <BenchmarkPanel rows={bench} size={size} samples={BENCH_SAMPLES} />
        </aside>
      </main>
    </div>
  );
}
