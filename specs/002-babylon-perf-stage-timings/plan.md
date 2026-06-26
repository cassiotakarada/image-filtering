# Implementation Plan: Babylon Per-Stage Timing Breakdown

**Branch**: `002-babylon-perf-stage-timings` | **Date**: 2026-06-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-babylon-perf-stage-timings/spec.md`

## Summary

Add a five-stage timing breakdown to each Babylon BenchRow (`compile`,
`upload`, `compute`, `readback`, `round-trip`) so a reviewer can read why
Babylon (WebGPU, main thread) is unexpectedly slower than Babylon (WebGL,
worker) on the same image — without opening dev-tools. The current numbers
on the 512² synthetic phantom (Babylon-WebGL 122.00 ms vs Babylon-WebGPU
285.70 ms) are evidence of *something*, but no evidence of *what*; the
breakdown turns "Babylon-WebGPU is unexpectedly slow" into the dominant-stage
observation the spike's port-decision needs (spec SC-003).

**Technical approach (from research):** Extend `FilterResult` with an
*optional* `stages?: StageTimings` field (parity-preserving — CPU and any
future engine that has no meaningful breakdown simply omit it). The two
Babylon engines compute the four GPU-side stages (compile/upload/compute/
readback) from `performance.now()` boundaries that are natural seams in the
existing code, and ship them back inside `FilterResult` (worker case) or
return them directly (main-thread WebGPU case). The fifth stage,
**round-trip**, is measured only at the worker seam in
`BabylonFilterEngine` — wall-clock around `postMessage("run") → "result"`
minus the worker's reported `elapsedMs`. The benchmark layer in `App.tsx`
accumulates per-stage samples in the same `BENCH_SAMPLES` loop that already
produces the row's median `ms / run`, sorts and picks the per-stage median
with the same warmup-discard policy, and attaches the five stage medians to
the Babylon `BenchRow`s. `BenchmarkPanel.tsx` renders five new sub-cells
under each Babylon row, leaving the locked five-row layout from spec 001
otherwise unchanged.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), targeting ES2022 / browser ESM

**Primary Dependencies**:
- `@babylonjs/core` `^7.54.0` (WebGL + WebGPU engines, GLSL→WGSL via twgsl/glslang)
- `@cornerstonejs/core` `^4.15.21` (untouched — Cornerstone rows do not gain stage timings)
- `react` `^18.3.1`, `react-dom` `^18.3.1`
- `vite` `^6.0.5`

**Storage**: N/A — in-memory only; no persistence

**Testing**: No automated test runner (per constitution Development Workflow).
Verification is `tsc --noEmit` + `npm run build` + a reviewer-only browser
walk that reads the new sub-cells and confirms each Babylon row's stages sum
to within tolerance of its `ms / run` median (SC-002).

**Target Platform**: Modern desktop browsers (Chrome 113+ / Edge 113+ for
the WebGPU row; any WebGL2 browser for the WebGL row).

**Project Type**: Single-page web application (Vite + React).

**Performance Goals**: Instrumentation overhead MUST be at the noise floor.
Concretely: the rolled-up `ms / run` for Babylon-WebGL, Babylon-WebGPU, and
CPU before vs after this feature MUST differ by no more than the inter-run
variance already observed on the same machine (SC-004). The new breakdown
exists to *explain* perf, not to introduce a new perf cost.

**Constraints**:
- Constitution Principle III (Display-Seam Isolation) — all engine-side
  changes live under `src/engine/babylon/`; no Cornerstone or React types
  imported there. `src/engine/types.ts` gains an optional `stages?` field on
  `FilterResult`, which is the only widening of the public engine contract.
- Constitution Principle IV (Single Readback) — exactly one `readPixels()`
  per `run()` is preserved. Stage boundaries are pure observation
  (`performance.now()` reads); no extra GPU syncs, no per-pass readbacks,
  no `gl.finish()` calls.
- Constitution Principle I (Engine Parity) — the filter graph, math, and
  operation order in `run()` are unchanged. Only timing boundaries that
  already exist as natural seams in the code are observed.
- Constitution Principle V (Synthetic-Data-Only) — no fixtures added.

**Scale/Scope**: Changes in 6 source files + README. No new directories, no
new dependencies. The data shape (`StageTimings`) lives in
`src/engine/types.ts`; the four GPU-side stages are measured in
`babylon.worker.ts` (WebGL engine) and `BabylonWebGPUEngine.ts` (WebGPU
engine); the round-trip is measured in `BabylonFilterEngine.ts`; the worker
protocol grows by one optional field; the UI extends `BenchRow` in
`BenchmarkPanel.tsx` and the median accumulator in `App.tsx`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Initial gate (pre-research):**

| Principle | Status | Notes |
|---|---|---|
| I. Engine Parity (NON-NEGOTIABLE) | ✅ PASS | The filter graph, the math, and the operation order inside `run()` are not changed. `FilterResult` gains an optional field; engines that don't fill it remain compliant. The CPU engine and any future engine are unaffected unless they opt in. |
| II. Diagnostic Fidelity | ✅ PASS | No change to bit depth, windowing, or output format. Filter outputs are byte-for-byte identical. |
| III. Display-Seam Isolation | ✅ PASS | All edits live under `src/engine/babylon/` (engine-internal observations) and `src/components/` + `src/App.tsx` (UI). `src/engine/types.ts` widens by one optional field on the engine's *own* public contract — not a leak from Cornerstone or React into the portable folder. |
| IV. Off-Main-Thread + Single Readback | ✅ PASS | Exactly one `readPixels()` per `run()` is preserved. Stage timing boundaries are `performance.now()` reads only; they introduce no GPU syncs, no `gl.finish()`, no extra readbacks. The WebGL engine stays in the worker; the WebGPU engine stays on the main thread (round-trip on that row is correctly reported as 0). |
| V. Synthetic-Data-Only (NON-NEGOTIABLE) | ✅ PASS | No test fixtures, no patient data of any kind, no new sources added. |
| Protected Branches (NON-NEGOTIABLE) | ✅ PASS | Work is on `002-babylon-perf-stage-timings`, branched from `bruno`. PR will target `bruno`. No commits to main/master/develop. |

**Post-design re-check:** see end of Phase 1 below.

## Project Structure

### Documentation (this feature)

```text
specs/002-babylon-perf-stage-timings/
├── spec.md                                # /speckit.specify output
├── plan.md                                # this file
├── research.md                            # Phase 0 — boundary placement + sync hazards
├── data-model.md                          # Phase 1 — StageTimings + per-row aggregation
├── quickstart.md                          # Phase 1 — reviewer browser walk
├── contracts/
│   └── stage-breakdown.md                 # UI + engine contract (stage names, n/a, sums)
├── checklists/
│   └── requirements.md                    # /speckit.specify quality check (already present)
└── tasks.md                               # /speckit.tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── App.tsx                                # MODIFIED — accumulate per-stage samples in BENCH_SAMPLES loop; median; attach to Babylon rows
├── components/
│   └── BenchmarkPanel.tsx                 # MODIFIED — extend BenchRow with stages?; render five sub-cells under Babylon rows; update hint paragraph
├── engine/
│   ├── types.ts                           # MODIFIED — add StageTimings type + optional stages?: StageTimings on FilterResult
│   └── babylon/
│       ├── BabylonFilterEngine.ts         # MODIFIED — measure round-trip wall-clock; forward worker-reported stages into FilterResult
│       ├── babylon.worker.ts              # MODIFIED — measure compile/upload/compute/readback inside handleRun(); ship in "result" message
│       ├── BabylonWebGPUEngine.ts         # MODIFIED — measure compile/upload/compute/readback in run(); round-trip = 0
│       └── protocol.ts                    # MODIFIED — extend "result" message with optional stages field

README.md                                  # MODIFIED — note the breakdown under "Benchmark table layout"
```

**Structure Decision**: Single-project SPA. Six source files + README touched.
No new directories, no new modules, no new dependencies. The change-set is
deliberately narrow: a one-field widening of `FilterResult`, four
instrumentation patches inside Babylon, and a table-row extension in the UI.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(empty — all gates pass without justification)*

---

## Phase 0 — Outline & Research

**Output:** [research.md](./research.md)

Unknowns extracted from spec + Technical Context:

1. **Where exactly do the four GPU-side stage boundaries land in the existing
   Babylon code?** — feeds FR-008/FR-009/FR-010/FR-011 (each stage's
   inclusion/exclusion rule) and SC-002 (stages must sum to within tolerance
   of the row's `ms / run`).
2. **Is `proc.readPixels()` resolution time on the WebGPU path actually a
   meaningful "readback" measurement, or does the bulk of the cost live in
   an implicit GPU sync at `proc.render()` instead?** — feeds FR-010/FR-011
   and the likely-dominant-stage hypothesis behind SC-003.
3. **Does the existing `proc.isReady()` poll loop (`for (let i = 0; i < 600
   && !proc.isReady(); i++) await sleep(2)`) actually cost any wall time on
   warmed-up runs, or does it return true on the first poll after warmup?**
   — feeds FR-008 (compile stage definition: `0.00` when warm).
4. **How is the worker round-trip measured without introducing a clock-sync
   bug between the main-thread and worker `performance.now()` clocks?** —
   feeds FR-012 (round-trip = main wall-clock − worker `elapsedMs`).
5. **Does measuring `performance.now()` four times per run on the GPU paths
   change the observed `ms / run`?** — feeds SC-004 (instrumentation
   overhead at the noise floor).

All are answered in `research.md`. Headline findings:

- The four GPU-side boundaries already exist as **natural code seams** in
  both Babylon engines (shader-ready poll, uniform/texture setters,
  `proc.render()`, `await proc.readPixels()`). No restructuring needed.
- `readPixels()` on the WebGPU path is **the main suspect** for the regression
  because it forces a CPU↔GPU sync through a staging buffer; the timing will
  prove or disprove that.
- `performance.now()` calls cost ~microseconds on modern browsers; four of them
  per run are well below the noise floor (SC-004 holds).

## Phase 1 — Design & Contracts

**Outputs:** [data-model.md](./data-model.md), [contracts/stage-breakdown.md](./contracts/stage-breakdown.md), [quickstart.md](./quickstart.md)

### 1. Entities — see [data-model.md](./data-model.md)

- `StageTimings` (NEW) — `{ compile: number; upload: number; compute: number; readback: number; roundTrip: number }`. All five fields required; engines that don't measure a stage emit `0` (with the contract-documented meaning "stage observed and amortized" — distinct from "stage not applicable", which is encoded by the *absence* of the whole `stages?` field).
- `FilterResult` (EXTENDED) — gains optional `stages?: StageTimings`. Engines that compute stages set it; CPU does not. UI treats absence as "no breakdown for this row".
- `BenchRow` (EXTENDED) — gains optional `stages?: StageTimings` so the panel can display the per-row stage medians independently from the row's `ms / run` median. Filled only for `kind: "babylon"` and `kind: "webgpu"`.
- `Babylon "result" worker message` (EXTENDED) — gains optional `stages?: StageTimings` on the wire format in `src/engine/babylon/protocol.ts`. The worker emits the four GPU-side stages; round-trip is computed and attached by `BabylonFilterEngine` on the main thread before resolving the `run()` promise.

### 2. UI + engine contract — see [contracts/stage-breakdown.md](./contracts/stage-breakdown.md)

Documents:

- **C-1**: The exact stage names, units, and inclusion/exclusion rules (`compile` includes shader-ready wait but excludes engine init; `upload` includes uniform setters + CLAHE/LUT texture binds inside `run()` but excludes `setImage`; `compute` is just `proc.render()`; `readback` is the awaited `proc.readPixels()` promise; `round-trip` is main-thread wall-clock minus worker `elapsedMs`).
- **C-2**: The sub-row UI layout under each Babylon row (five sub-cells, two-decimal ms, `—` when `stages?` is absent).
- **C-3**: The reconciliation rule (sum of stages within max(1 ms, 5 %) of the row's `ms / run`; larger gaps are a defect).
- **C-4**: The locked five-row layout from spec 001 (C-2) is preserved verbatim. Stage breakdown is an *addition*, never a row reorder.

### 3. Quickstart — see [quickstart.md](./quickstart.md)

A reviewer-runnable checklist: load the dev server, click **Run benchmark**,
read the five sub-values under each Babylon row, write a one-line conclusion
identifying the dominant stage on the WebGPU row.

### 4. Agent context update

Update [.github/copilot-instructions.md](../../.github/copilot-instructions.md)
SPECKIT block to point to this plan file.

---

### Constitution Check — Re-evaluation after Phase 1

Re-checking the same gates against the now-concrete design:

| Principle | Status | Post-design notes |
|---|---|---|
| I. Engine Parity (NON-NEGOTIABLE) | ✅ PASS | `FilterResult.stages` is optional. CPU engine returns no stages and remains conformant. Babylon engines fill stages; the underlying filter graph, math, and operation order are byte-for-byte unchanged. |
| II. Diagnostic Fidelity | ✅ PASS | No change to bit depth, windowing, or output. `data` field of `FilterResult` is unchanged. |
| III. Display-Seam Isolation | ✅ PASS | Confirmed: all engine-side instrumentation is inside `src/engine/babylon/`. `src/engine/types.ts` widens by one optional field on the engine's own public contract — no Cornerstone or React imports introduced. |
| IV. Off-Main-Thread + Single Readback | ✅ PASS | Exactly one `readPixels()` per `run()` is preserved on both Babylon paths. Stage boundaries are `performance.now()` reads only — no GPU sync points, no extra readbacks. |
| V. Synthetic-Data-Only (NON-NEGOTIABLE) | ✅ PASS | No fixtures, no patient data. |
| Protected Branches (NON-NEGOTIABLE) | ✅ PASS | On `002-babylon-perf-stage-timings`. PR will target `bruno`. |

**Gate status: PASS — no Complexity Tracking entries needed.**

---

## Done When (Phase 2 prerequisites met)

- [x] Plan workflow executed; Phase 0 research generated and unknowns resolved.
- [x] Phase 1 design artifacts generated: `research.md`, `data-model.md`, `quickstart.md`, `contracts/stage-breakdown.md`.
- [x] Agent context updated.
- [x] Constitution Check passes both pre- and post-design.

Next: run `/speckit.tasks` on this branch to generate `tasks.md`.
