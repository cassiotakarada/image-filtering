# Feature Specification: Babylon per-stage timing breakdown

**Feature Branch**: `002-babylon-perf-stage-timings`

**Created**: 2026-06-26

**Status**: Draft

**Input**: User description: "investigate why Babylon's GPU rows are slower than expected; add per-stage timing breakdown (compile / upload / compute / readback / worker round-trip) to the BenchRow so the bottleneck is visible without console digging."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See where Babylon spends its time, in the benchmark panel (Priority: P1)

A reviewer (or the spike author) runs the in-app benchmark and sees, for each Babylon row, a breakdown of how the row's median time decomposes into named stages — shader compile, parameter / texture upload, GPU compute (render submit), GPU→CPU readback, and worker round-trip overhead — without opening the dev-tools console or instrumenting code by hand.

**Why this priority**: This is the entire point of the feature. The current benchmark shows that Babylon (WebGPU, main thread) at 285.70 ms is ~2.3× slower than Babylon (WebGL, worker) at 122.00 ms on the same 512² synthetic phantom — the opposite of the expected ordering for a GPU backend with no worker round-trip. The bottleneck can only be guessed at from the rolled-up `elapsedMs` number; surfacing the breakdown is the only way to turn the spike's "Babylon-WebGPU is unexpectedly slow" observation into actionable evidence for the port decision.

**Independent Test**: Open the app on the synthetic phantom, click the Benchmark button, and visually confirm that the Babylon (WebGL, worker) and Babylon (WebGPU, main thread) rows each show their per-stage numbers in the panel (numbers must be present, > 0 ms, and sum to within a small tolerance of the row's reported `ms / run`). No console interaction required.

**Acceptance Scenarios**:

1. **Given** the app is loaded with the default synthetic phantom and both Babylon engines are available, **When** the user clicks the Benchmark button, **Then** the panel renders both Babylon rows with five named stage values each (compile, upload, compute, readback, round-trip) in milliseconds, and a sixth "total" or "ms / run" column equal to the row's existing median (within ±1 ms tolerance).
2. **Given** the Babylon (WebGPU) engine is unavailable (e.g. the browser has no `navigator.gpu`), **When** the user clicks the Benchmark button, **Then** the WebGPU row appears in its locked position with `ms / run = n/a` and stage values blank (or `—`), and the rest of the rows render and behave exactly as in spec 001.
3. **Given** a Babylon engine produces stage timings, **When** the same benchmark is re-run on the same phantom and the same filter parameters, **Then** each stage's reported value is stable across runs to the same degree the overall `ms / run` already is (i.e. the new numbers inherit the existing median-of-`BENCH_SAMPLES` smoothing, not a single-run snapshot).

---

### User Story 2 - Diagnose the Babylon-WebGPU regression (Priority: P1)

The reviewer can read the breakdown and form a credible hypothesis about why Babylon (WebGPU, main thread) is slower than Babylon (WebGL, worker), without writing new code. Common candidate explanations the breakdown must let the reviewer distinguish between:

- Shader compile cost leaking into the timed region (one-time cost not properly warmed up).
- Per-call CPU→GPU upload cost (uniforms, CLAHE map texture, LUT rebinds).
- The actual GPU render submit being slow (unlikely but possible).
- Float32 readback being expensive on the WebGPU backend (most likely culprit on the WebGPU path because float textures are not linearly filterable and the readback may go through a staging buffer).
- Worker round-trip dominating the WebGL path while WebGPU pays its cost on the main thread.

**Why this priority**: Same severity as P1 above — without this story, P1 produces a UI change but no evidence improvement, defeating the spike's whole purpose. The two stories ship together.

**Independent Test**: Open the app, run the benchmark on the 512² phantom. For each of the two Babylon rows, identify (just by reading the panel) which stage is the largest contributor to that row's median, and write a one-line conclusion such as "Babylon-WebGPU is dominated by readback (~X ms of Y total)". This must be possible without console logs.

**Acceptance Scenarios**:

1. **Given** the breakdown is displayed for both Babylon rows on the same 512² benchmark, **When** the reviewer compares the two rows' stage values, **Then** the panel makes it visually obvious which stage(s) differ between WebGL and WebGPU (e.g. the dominant stage on each row is identifiable at a glance).
2. **Given** the breakdown is displayed, **When** the reviewer looks at the Babylon (WebGL, worker) row, **Then** the "worker round-trip" stage shows a non-zero value, and the same stage on the Babylon (WebGPU, main thread) row shows zero (or `—`), because that engine runs on the main thread by design.

---

### Edge Cases

- **One Babylon engine fails to initialize**: The benchmark must still render the surviving engine's full breakdown; the failed engine's row shows `ms / run = n/a` and blank stages (matching spec 001's unavailable-row contract).
- **An engine succeeds but a single sample throws**: The existing warmup-discard + median-of-`BENCH_SAMPLES` logic already tolerates this for the rolled-up number; the same robustness must apply per stage (a missed stage sample on one run must not zero out the median for that stage).
- **Stages sum slightly differently from the reported `ms / run`**: Acceptable, because the stages are sampled with separate `performance.now()` boundaries and the existing `elapsedMs` is one boundary pair around the render+readback span. A small reconciliation delta (e.g. < 1 ms or < 5 % of the total) is fine and need not be flagged in the UI; a large gap (≥ 5 % or > 5 ms, whichever is larger) is a defect because it means a chunk of time is unaccounted for.
- **Filter parameters change between Benchmark clicks** (e.g. CLAHE turned on, which uploads an extra texture): The breakdown must reflect the new cost mix on the next click — i.e. the upload stage gets larger when CLAHE is on. Numbers from a previous click must not be cached and shown alongside new ones.
- **Cornerstone rows**: Untouched by this feature. Their existing single-number behavior (windowing-only via `IMAGE_RENDERED`) is preserved exactly as in spec 001; they do not gain stage columns.
- **CPU row**: Its single-number behavior is preserved. A CPU breakdown is meaningless under the current pipeline (it's one synchronous JS pass) and is not added; the CPU row stays as the baseline anchor for the "vs CPU" column.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The benchmark UI MUST display, for each of the two Babylon rows (`babylon` and `webgpu`), the median per-stage timing for these five named stages: shader **compile**, **upload** (per-run parameter / texture uploads), **compute** (GPU render submit), **readback** (GPU→CPU pixel retrieval), and **round-trip** (main↔worker message overhead).
- **FR-002**: Each stage value MUST be presented in milliseconds with the same numeric precision (two decimal places) as the existing `ms / run` column.
- **FR-003**: Per-stage timing values MUST be derived from the same `BENCH_SAMPLES`-sample run that already produces the row's median `ms / run`, using a per-stage median (not a single-run snapshot, not a sum-then-average).
- **FR-004**: The existing rolled-up `ms / run` column MUST continue to be displayed for every row and MUST continue to mean exactly what it means today (median of warmup-discarded sampled runs, covering parameter upload + compute + readback inside the engine). Adding stage breakdown MUST NOT change the meaning, position, or precision of that column.
- **FR-005**: The five-row table layout from spec 001 (`Babylon-WebGL`, `Cornerstone-WebGL`, `Babylon-WebGPU`, `Cornerstone-WebGPU`, `CPU`, in that locked order) MUST be preserved unchanged. Stage breakdown is an *addition* to the two Babylon rows, never a row reorder.
- **FR-006**: When a Babylon row is unavailable (engine failed to init, or shader compile failed), the row MUST still appear in its locked slot with `ms / run = n/a` and stage values rendered as `—` or blank. The breakdown UI MUST NOT crash, hide other rows, or shift the row order in this case.
- **FR-007**: The "worker round-trip" stage on the Babylon (WebGPU, main thread) row MUST report zero (or `—`) without crashing, because that engine runs on the main thread by architectural choice (see `src/engine/babylon/BabylonWebGPUEngine.ts` header: GLSL→WGSL transpiler can't run in a module worker, so the engine lives on the main thread).
- **FR-008**: The "compile" stage MUST capture the cost of shader compilation that is observably attributable to a given `run()` call. If shader compile happens once at engine init and is fully amortized (i.e. `proc.isReady()` returns true immediately for every sampled run), the stage MUST report `0.00`. If compile cost leaks into a sampled run (e.g. `proc.isReady()` polling actually waits on the first sample after a parameter change), the stage MUST report the wait time observed *for that sample*, and the warmup-discard policy MUST give compile cost the same first-run-discard treatment the overall `ms / run` already gets.
- **FR-009**: The "upload" stage MUST account for the per-`run()` parameter and texture uploads inside the engine (uniform setters, CLAHE map texture build/bind when CLAHE > 0, LUT rebind). It MUST NOT include the one-time `setImage()` upload, which is not part of `run()` and which the existing `ms / run` does not measure either.
- **FR-010**: The "compute" stage MUST measure only the GPU render submit (`proc.render()` and equivalent). It MUST NOT include readback time.
- **FR-011**: The "readback" stage MUST measure the GPU→CPU pixel retrieval call (`proc.readPixels()` resolution time, including any implicit GPU sync). It MUST NOT include the subsequent JS-side channel un-interleave that converts RGBA float to grayscale or RGB, which is a CPU-side post-step and conceptually separate from the GPU readback.
- **FR-012**: The "round-trip" stage on the Babylon (WebGL, worker) row MUST measure the difference between (a) the main-thread wall-time around the `postMessage("run") → "result"` round trip and (b) the in-worker `elapsedMs` already reported by the worker. The resulting value represents pure postMessage / transfer overhead and MUST be reported in the same units as the other stages.
- **FR-013**: Each `BENCH_SAMPLES` series on the two Babylon rows MUST apply a warmup-discard policy: one extra discarded `run()` call before the sampling loop, whose result is dropped before any median is taken — both for the rolled-up `ms / run` median and for each per-stage median. This feature INTRODUCES this discard on the Babylon and CPU paths to align them with the Cornerstone path's existing pattern in `src/App.tsx` (the Cornerstone bench already does `await cornerstoneBenchRenderWebGL(...) // warmup (discarded)` before its sampling loop). Without the discard, first-run shader-compile / driver-warmup cost would smear the `compile` stage's median upward despite the engine being warm by sample 2, breaking the SC-002 reconciliation bound.
- **FR-014**: The mechanism that produces the stage numbers MUST be a parity-preserving addition to the engine layer, not a Babylon-only side channel. That is: the data shape (e.g. an optional stage-timings field on the engine's per-run result) MUST be defined uniformly so that any engine implementing the interface *can* report stages; engines that have no meaningful per-stage breakdown (CPU, Cornerstone) MAY report `undefined`/empty without violating Engine Parity (`src/engine/types.ts`).
- **FR-015**: `src/engine/` MUST remain free of Cornerstone or React imports as a result of this feature (Display-Seam Isolation per constitution principle III). Stage instrumentation lives behind the `FilterEngine` interface; the UI consumes the existing engine result shape plus the new stage field.
- **FR-016**: The exactly-one-readback rule from constitution principle IV MUST be preserved. Adding stage timings MUST NOT introduce additional `readPixels()` calls, additional GPU syncs, or per-pass readbacks during the filter graph.
- **FR-017**: The benchmark MUST continue to produce stable, repeatable numbers across re-runs to the same degree it does today (FR-010 of spec 001). The added instrumentation MUST NOT change the filter graph, the `setImage` flow, or the order of operations in a `run()` call; it MUST only observe boundaries that already exist.
- **FR-018**: A short reviewer-facing note in the benchmark panel (the existing `<p className="hint">` hint paragraph below the table) MUST explain the five stage names in one or two sentences each, so a reviewer landing on the panel without context can interpret the columns. The note MUST also explain why CPU and Cornerstone rows do not have stage breakdowns.

### Key Entities *(include if feature involves data)*

- **Stage Timing**: A named, milliseconds-valued measurement of one phase of a single `run()` call on a single engine. Five named stages are defined (compile, upload, compute, readback, round-trip). A stage value of `0` is meaningful (e.g. "round-trip" on a main-thread engine, or "compile" when shaders are already warm) and is distinct from "stage not applicable" (rendered as `—`).
- **Per-Row Stage Breakdown**: The set of five stage medians associated with one Babylon BenchRow. It is the per-stage analogue of the row's existing `ms / run` median: same `BENCH_SAMPLES` count, same warmup-discard, same sort-and-pick-middle aggregation, just applied independently per stage.
- **Engine Per-Run Result (extended)**: The shape returned by `FilterEngine.run()` today (data + width + height + components + min + max + elapsedMs) gains an *optional* stage-timings field. Engines that cannot meaningfully report stages omit it. The UI's existing `elapsedMs`-based path remains the source of truth for the `ms / run` column.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer with no prior knowledge of the implementation can open the running app, click Benchmark on the default 512² phantom, and within 30 seconds state which of the five stages dominates the Babylon (WebGPU) row's total time, without opening dev-tools or running anything in a terminal.
- **SC-002**: The sum of the five stage medians on a given Babylon row reconciles with that row's reported `ms / run` to within the larger of 1 ms and 5 % of the row's total. (Larger gaps indicate unmeasured time and are a defect, per Edge Cases.)
- **SC-003**: After this feature ships, the spike's README or the panel itself contains a documented, evidence-backed answer to the question "why is Babylon-WebGPU slower than Babylon-WebGL on the 512² phantom?" — i.e. the dominant-stage observation that the breakdown enables, captured in writing for the port decision. (The fix itself is out of scope for this feature; the *answer* is the deliverable.)
- **SC-004**: The existing benchmark numbers (the `ms / run` column on each of the five rows) are unchanged in median, modulo normal run-to-run variance, by adding the instrumentation. Concretely, with no other code changes, the rolled-up `ms / run` for Babylon-WebGL, Babylon-WebGPU, and CPU before and after this feature differs by no more than the inter-run variance already observed on the same machine — i.e. instrumentation overhead must be at the noise floor, not visible as a new "Babylon is slower now" regression.
- **SC-005**: The "vs CPU" column continues to populate only on the two Babylon rows (per spec 001), with the same numeric meaning. Adding stage breakdown does not introduce new speedup ratios or change which rows compare to the CPU baseline.

## Assumptions

- The benchmark UI lives in `src/components/BenchmarkPanel.tsx` and is fed by `runBenchmark` in `src/App.tsx`, which builds a keyed `engineRows` map and assembles the five rows in the locked order from spec 001's contract C-2. Stage breakdown is added to that same data flow: per-row stage medians are accumulated in the same sampling loop that produces the `ms / run` median, then attached to the appropriate row object before assembly.
- The Babylon-side stages (compile, upload, compute, readback) can be measured by inserting `performance.now()` boundaries inside the engines themselves (`src/engine/babylon/babylon.worker.ts` for the WebGL worker engine; `src/engine/babylon/BabylonWebGPUEngine.ts` for the main-thread WebGPU engine), without changing the order of operations or the number of GPU readbacks per `run()`. The boundaries are pure observation, not mutation of the filter graph.
- The "round-trip" stage on the worker engine is best measured at the seam — i.e. on the main thread (`BabylonFilterEngine`), as the wall-clock around `postMessage("run") → onmessage("result")` minus the worker-side `elapsedMs`. The worker already reports `elapsedMs`; this feature reuses that and does not require a new clock-synchronization mechanism.
- The CPU engine (`src/engine/cpu/CpuFilterEngine.ts`) does not need stage breakdown. Its single-pass synchronous nature makes the breakdown either trivially-equal-to-total or meaningless to split. The CPU row remains the baseline anchor and continues to populate `ms / run` only.
- Cornerstone rows are completely untouched. Their existing windowing-only `IMAGE_RENDERED` timing path from spec 001 is preserved, and they do not gain stage columns. The hint paragraph in the panel will note this so reviewers know the breakdown is Babylon-only on purpose.
- The locked five-row order (Babylon-WebGL, Cornerstone-WebGL, Babylon-WebGPU, Cornerstone-WebGPU, CPU) from spec 001's contract C-2 is preserved verbatim. This feature only widens what each row displays; it does not add, remove, or reorder rows.
- The constitution version in effect is `1.3.0`. Principle III (Display-Seam Isolation) and Principle IV (Off-Main-Thread + Single Readback) are the constraints most relevant to this feature; both are honored by the instrumentation-as-observation design above. Protected Branches rules (`bruno` is the only legal PR target) apply at merge time, not at spec time.
- The author cannot run the app in a browser (constitution: "Browser validation gap"). T-style reviewer-only quickstart walks will be the runtime gate for this feature too, exactly as they were for spec 001.
