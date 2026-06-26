---
description: "Implementation tasks for: Babylon Per-Stage Timing Breakdown"
---

# Tasks: Babylon Per-Stage Timing Breakdown

**Input**: Design documents from [specs/002-babylon-perf-stage-timings/](.)

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/stage-breakdown.md](./contracts/stage-breakdown.md)

**Tests**: Not requested. No test tasks generated (spike has no automated test runner per constitution).

**Organization**: Tasks are grouped by user story. Both user stories (US1, US2) are priority P1 in the spec and ship together — US1 delivers the per-row breakdown UI; US2 delivers the reviewer's ability to draw a dominant-stage conclusion from it. US2 is largely a reading activity and its implementation tasks are small (hint paragraph + README + reviewer walk).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 or US2 (Setup/Foundational/Polish phases carry no story label)
- Include exact file paths in descriptions

## Path Conventions

Single-page React + Vite app (per [plan.md](./plan.md) "Project Structure"). All source under `src/`. No `tests/` directory (no automated test runner). Documentation update in [README.md](../../README.md).

---

## Phase 1: Setup

**Purpose**: No new project initialization needed. This feature does not add dependencies or new directories — it widens existing types and instruments existing code paths. The single setup task is to capture the baseline `ms / run` numbers so SC-004 (instrumentation overhead at noise floor) can be verified after implementation.

- [ ] T001 Capture baseline `ms / run` for Babylon-WebGL, Babylon-WebGPU, and CPU rows by running `npm run dev`, opening the default 512² phantom in a WebGPU-capable browser, clicking **Run benchmark** 3 times, and recording the medians (paste into the PR description under "Baseline (before instrumentation)"). Reviewer-only task; the spike author cannot run a browser (constitution: "Browser validation gap").

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type-level plumbing that both user stories depend on. The `StageTimings` shape, the `FilterResult` widening, the worker protocol widening, and the `BenchRow` widening MUST all exist before either engine-side instrumentation (US1) or UI rendering (US1 + US2) can compile.

**⚠️ CRITICAL**: No user-story task may start until Phase 2 is complete.

- [X] T002 Add the `StageTimings` interface and extend `FilterResult` with the optional `stages?: StageTimings` field in [src/engine/types.ts](../../src/engine/types.ts), per [data-model.md](./data-model.md) "`StageTimings` (NEW)" and "`FilterResult` (EXTENDED)". Include JSDoc per [contracts/stage-breakdown.md](./contracts/stage-breakdown.md) C-1 inclusion/exclusion rules.
- [X] T003 [P] Extend the `result` variant of `FromWorker` in [src/engine/babylon/protocol.ts](../../src/engine/babylon/protocol.ts) with the optional `stages?: Omit<StageTimings, "roundTrip">` field. Import `StageTimings` from `../types`. JSDoc must note that `roundTrip` is intentionally absent here because the worker has no visibility into its own postMessage overhead (added by `BabylonFilterEngine` on the main thread).
- [X] T004 [P] Extend the `BenchRow` interface in [src/components/BenchmarkPanel.tsx](../../src/components/BenchmarkPanel.tsx) with the optional `stages?: StageTimings` field, imported from `../engine/types` (re-export `StageTimings` through `../engine` if the barrel does not already expose it). JSDoc must state the constraint from data-model.md: filled only for `kind: "babylon"` and `kind: "webgpu"`, never for the three other kinds.
- [X] T005 [P] Ensure `StageTimings` is exported from the engine barrel [src/engine/index.ts](../../src/engine/index.ts) so the UI layer can import it through the same surface it already uses for `EngineKind` / `FilterEngine`. Verify with `tsc --noEmit`.

**Checkpoint**: Types compile. `npm run build` should still succeed (the new field is optional; no existing call site has to change yet).

---

## Phase 3: User Story 1 — See breakdown in panel (Priority: P1) 🎯 MVP

**Goal**: After clicking **Run benchmark** on the default 512² synthetic phantom, both Babylon rows (`Babylon (WebGL, worker)` and `Babylon (WebGPU, main thread)`) render five per-stage values (compile, upload, compute, readback, round-trip) as a secondary line under the row, sourced from per-stage medians of the same `BENCH_SAMPLES`-sample run that already produces the row's `ms / run` median.

**Independent Test**: Quickstart steps 1–5 ([quickstart.md](./quickstart.md)) pass without dev-tools or terminal interaction. Each Babylon row shows five sub-values; sum reconciles to within `max(1 ms, 5 %)` of the row's `ms / run` (contract C-3).

### Implementation for User Story 1

- [X] T006 [US1] Instrument `handleRun` in [src/engine/babylon/babylon.worker.ts](../../src/engine/babylon/babylon.worker.ts): add four `performance.now()` boundaries per the table in [research.md](./research.md) Decision 1 (`t_run_start` → `t_after_isReady` → `t_after_uniforms` → `t_after_render` → `t_after_readPixels`). Move the existing `const t0 = performance.now()` to *before* the `proc.isReady()` polling loop so the existing `elapsedMs` becomes `compile + upload + compute + readback` and SC-002 reconciliation holds. Compute the four stage durations and ship them in the `result` message under `stages` (without `roundTrip`).
- [X] T007 [P] [US1] Instrument `run()` in [src/engine/babylon/BabylonWebGPUEngine.ts](../../src/engine/babylon/BabylonWebGPUEngine.ts) with the same four boundaries and the same `t0` relocation as T006. Return the four stages directly on the engine's `FilterResult` under `stages`, with `roundTrip: 0` (this engine runs on the main thread by design — spec FR-007). The on-disk file is independent from `babylon.worker.ts`, so this is `[P]` with T006.
- [X] T008 [US1] Measure `roundTrip` in [src/engine/babylon/BabylonFilterEngine.ts](../../src/engine/babylon/BabylonFilterEngine.ts): capture `tSend = performance.now()` immediately before `this.post({ type: "run", ... })` and `tRecv = performance.now()` at the top of the `case "result":` branch. When the result has `stages`, compute `roundTrip = Math.max(0, (tRecv - tSend) - msg.elapsedMs)` (per [research.md](./research.md) Decision 4) and attach it to the `FilterResult.stages` that resolves the pending promise. Track `tSend` per `id` in a `Map<number, number>` parallel to the existing `pending` map; clean up on resolve / reject / dispose. Depends on T006 (worker must emit `stages` before this main-thread plumbing has anything to attach `roundTrip` to).
- [X] T009 [US1] Refactor `runBenchmark` in [src/App.tsx](../../src/App.tsx) to accumulate per-stage samples alongside the existing `elapsedMs` samples, AND add warmup-discard to the Babylon/CPU paths (per FR-013 and [research.md](./research.md) Decision 3 "Implementation note"). Specifically: (a) inside the `for (const k of order)` loop in `runBenchmark`, before the existing `for (let i = 0; i < BENCH_SAMPLES; i++)` sampling loop and inside the same `try` block, add one discarded `await eng.run(params);` call whose return value is thrown away — mirrors the Cornerstone path's existing `await cornerstoneBenchRenderWebGL(...) // warmup (discarded)` pattern around line 355 of `App.tsx`. (b) Update the surrounding comment (currently "Warmup-discard + BENCH_SAMPLES median sampling is preserved for every timed row") to be factually correct now that the discard exists. (c) For each engine kind in `["babylon", "webgpu"]` (the only two that emit stages), keep five parallel `number[]` arrays alongside the existing `times[]`. In the sampling loop, when `r.stages` is present, push each stage value into its array. (d) After the loop, sort each stage array and pick the middle element (per-stage median). Bundle the five medians into a `StageTimings` object and attach it to the row in the existing `engineRows[k] = { ... }` assembly (only on `babylon` / `webgpu` kinds; CPU and Cornerstone rows remain unchanged). Depends on T006, T007, T008.
- [X] T010 [US1] Render per-row stage sub-cells in [src/components/BenchmarkPanel.tsx](../../src/components/BenchmarkPanel.tsx) per [contracts/stage-breakdown.md](./contracts/stage-breakdown.md) C-2. When `r.stages` is present, render a secondary line (e.g. a second `<tr>` with `colSpan={4}` immediately after the row, or a `<div className="stages">` inside the `Engine` cell — implementer's choice) containing the five values in the fixed order `compile · upload · compute · readback · round-trip`, two-decimal ms. When `r.stages` is absent on a Babylon row (`ms` is `null` — engine unavailable), do not render the sub-line (or render `—` placeholders; either is acceptable per C-2). For non-Babylon rows (`cornerstone-webgl`, `cornerstone-webgpu`, `cpu`) the sub-line MUST NOT be rendered. Depends on T004, T009.

**Checkpoint** (US1 done): `npm run build` passes. Reviewer can run quickstart steps 1–5 and see five sub-values under each Babylon row with sums reconciling to within tolerance.

---

## Phase 4: User Story 2 — Diagnose the Babylon-WebGPU regression (Priority: P1)

**Goal**: A reviewer landing on the benchmark panel with no prior context can read the breakdown, identify which stage dominates each Babylon row, and write a one-line conclusion such as "Babylon-WebGPU at ~285 ms is dominated by readback (~283 ms)". This is the spec's SC-003 deliverable.

**Independent Test**: Quickstart step 6 ([quickstart.md](./quickstart.md)) completes — reviewer writes the dominant-stage conclusion into the PR description or README without opening dev-tools. The breakdown UI from US1 plus the hint paragraph + README from US2 together give the reviewer everything they need.

### Implementation for User Story 2

- [X] T011 [US2] Update the `<p className="hint">` paragraph in [src/components/BenchmarkPanel.tsx](../../src/components/BenchmarkPanel.tsx) per [contracts/stage-breakdown.md](./contracts/stage-breakdown.md) C-5. The paragraph MUST: (1) name and one-line-explain each of the five stages, (2) explain why CPU and Cornerstone rows have no breakdown (CPU is a single synchronous pass; Cornerstone does windowing only via `IMAGE_RENDERED` and doesn't decompose into the Babylon-shaped stages), (3) preserve the spec-001 disclaimer about the Cornerstone (WebGPU) placeholder row and the "windowing only" caveat. Depends on T010.
- [X] T012 [US2] Update [README.md](../../README.md) under the existing "Benchmark table layout" section (added by spec 001) with a new sub-section "Per-stage breakdown (Babylon rows only)" explaining the five stages briefly and stating that the breakdown is read-only diagnostic — the fix lives in a future feature, not this one (spec SC-003 frames the deliverable as the *answer*, not the fix). Depends on T011 (keep README and panel wording consistent).
- [ ] T013 [US2] Reviewer browser walk: run [quickstart.md](./quickstart.md) step 6 — identify the dominant stage on each Babylon row and write the one-line conclusion. Capture as a screenshot of the benchmark panel plus the conclusion text in the PR description. Reviewer-only task; the spike author cannot run a browser. Depends on T010, T011 (the panel and hint must be in their final form before the walk is meaningful).

**Checkpoint** (US2 done): Reviewer's dominant-stage conclusion is captured in the PR description; README documents the breakdown's purpose.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T014 Run `npm run build` (which runs `tsc --noEmit` + `vite build`) on the final state. MUST exit 0. This is the constitution's gate ("Type safety is the gate"). Depends on T002–T012.
- [ ] T015 Reviewer SC-004 noise-floor check: with the dev server running on this branch and on `bruno` side-by-side (two browser tabs, two terminals), run **Run benchmark** several times on each at 512², compare the `ms / run` medians for Babylon-WebGL, Babylon-WebGPU, and CPU. The new branch's medians MUST agree with `bruno`'s to within normal inter-run variance (a few ms). Larger drift is a defect — the instrumentation has cost. Reviewer-only task. Depends on T014.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 is a reviewer-only baseline capture; it does not block code work and can be done any time before T015.
- **Foundational (Phase 2)**: T002 unblocks everything. T003 / T004 / T005 are `[P]` once T002 lands (T002 defines `StageTimings`, the others import it).
- **US1 (Phase 3)**: Depends on Phase 2 complete. T006 + T007 are `[P]` (different files, both import the type defined in T002). T008 depends on T006 (worker must emit `stages` before the main thread can attach `roundTrip`). T009 depends on T006 + T007 + T008. T010 depends on T004 + T009.
- **US2 (Phase 4)**: Depends on Phase 3 substantially complete (T010 must render before the hint paragraph contextualizes it). T012 depends on T011 to keep wording consistent. T013 is the reviewer walk and depends on T010 + T011 being live.
- **Polish (Phase 5)**: T014 depends on all preceding code tasks (T002–T012). T015 depends on T014.

### Within Each User Story

- US1: types (Phase 2) → engine instrumentation (T006, T007) → main-thread round-trip plumbing (T008) → median accumulator (T009) → UI render (T010).
- US2: hint paragraph (T011) → README (T012) → reviewer walk (T013).

### Parallel Opportunities

- After T002 lands, T003 / T004 / T005 can be done in parallel (three separate files).
- After Phase 2 completes, T006 (`babylon.worker.ts`) and T007 (`BabylonWebGPUEngine.ts`) can be done in parallel (different files, no shared state). T008 (`BabylonFilterEngine.ts`) is independent of T007 in terms of files but logically waits on T006's worker-side `stages` payload to attach `roundTrip` to.

---

## Implementation Strategy

### MVP (US1 only)

US1 alone delivers a working benchmark panel with five sub-values under each Babylon row. The breakdown is technically *visible* and *reconcilable*; what US1 alone lacks is the reviewer-facing context to interpret it. If shipping US1 without US2 (not recommended), include at minimum a one-line panel note explaining that the sub-values mean per-stage medians in milliseconds.

### Recommended (US1 + US2 together)

Ship both stories in the same PR. The spec frames them as P1 + P1 for exactly this reason — US1 is the UI change; US2 is the interpretation context (hint paragraph + README + reviewer's written conclusion). Without US2, US1 produces visible numbers but no documented answer to "why is Babylon-WebGPU slow"; the spike's port-decision deliverable (SC-003) requires the conclusion in writing.

### Out of scope for this feature

- The actual perf *fix* for the Babylon-WebGPU regression. Once T013's conclusion is in hand, a separate feature (spec 003 or similar) chooses a remediation — likely moving the WebGPU engine into a worker once `@babylonjs/core` 8.x exposes a native WGSL pipeline for our shader pattern, or replacing `proc.readPixels()` with a pre-allocated mappable `GPUBuffer`. None of those changes belong to this feature.
- Per-stage breakdown for CPU or Cornerstone rows. Confirmed out-of-scope by spec assumptions and FR-005.
- Per-stage variance / min / max in the UI. Medians only, matching the existing `ms / run` column.

---

## Done When

- [ ] All Phase 2–4 code tasks complete; `npm run build` exits 0 (T014).
- [ ] Reviewer has captured baseline `ms / run` (T001) and confirmed no SC-004 regression on the final branch (T015).
- [ ] Reviewer has written the dominant-stage conclusion from quickstart step 6 (T013) into the PR description.
- [ ] PR opened targeting `bruno` (per constitution v1.3.0). Never main/master/develop.
