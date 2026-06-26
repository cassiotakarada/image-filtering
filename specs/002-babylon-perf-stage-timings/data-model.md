# Data Model — Babylon Per-Stage Timing Breakdown

**Feature**: `002-babylon-perf-stage-timings`
**Inputs**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md)

## Entities

### `StageTimings` (NEW)

A bag of five named, millisecond-valued, non-negative numbers measuring one
`run()` call's decomposition. Defined once in
`src/engine/types.ts` so every `FilterEngine` implementation references the
same shape.

```ts
export interface StageTimings {
  /** Shader-ready wait observed inside the timed region. 0 when warm. */
  compile: number;
  /** Per-run uniform setters + texture rebinds + CLAHE/LUT map upload. Excludes setImage(). */
  upload: number;
  /** GPU render submit only (proc.render() and equivalent). Excludes readback. */
  compute: number;
  /** GPU→CPU pixel retrieval (await proc.readPixels()). Includes the implicit GPU sync. */
  readback: number;
  /** Main↔worker postMessage overhead. 0 on main-thread engines by design. */
  roundTrip: number;
}
```

**Invariants:**

- All five fields are required and ≥ 0. `0` is a meaningful, distinct value:
  it means "stage was observed and contributed no measurable time" (e.g.
  `compile` on a warmed-up run, `roundTrip` on a main-thread engine).
  *Absence* of the whole `stages?` field on a `FilterResult` means "stage
  breakdown not applicable to this engine" (e.g. CPU).
- Units are milliseconds, matching the existing `elapsedMs` field's unit.

### `FilterResult` (EXTENDED)

Existing shape in `src/engine/types.ts`; gains one optional field:

```ts
export interface FilterResult {
  data: Float32Array;
  width: number;
  height: number;
  components: 1 | 3;
  min: number;
  max: number;
  /** Wall-clock ms inside the engine: parameter upload + compute + readback. Unchanged. */
  elapsedMs: number;
  /** Per-stage decomposition of elapsedMs. Engines that don't decompose omit it. */
  stages?: StageTimings;          // ← NEW
}
```

**Reconciliation rule:** When `stages` is present, the sum
`compile + upload + compute + readback` MUST equal `elapsedMs` to within
`max(1 ms, 5 %)` (see contract C-3). The `roundTrip` stage is *not* part of
`elapsedMs` — it's a wall-clock-only measurement that lives outside the
engine's internal timed region, and lives on the row's stage record only.

### `BenchRow` (EXTENDED)

Existing shape in `src/components/BenchmarkPanel.tsx`; gains one optional
field:

```ts
export interface BenchRow {
  kind: "babylon" | "webgpu" | "cpu" | "cornerstone-webgl" | "cornerstone-webgpu";
  name: string;
  ms: number | null;
  note?: string;
  backend?: string;
  /** Per-stage medians (median over BENCH_SAMPLES with same warmup-discard as `ms`). */
  stages?: StageTimings;          // ← NEW — filled for kind "babylon" and "webgpu" only
}
```

**Constraints:**

- `stages` MUST be populated for `kind: "babylon"` and `kind: "webgpu"` rows
  whenever `ms` is non-null. It MUST NOT be populated for `kind: "cpu"`,
  `kind: "cornerstone-webgl"`, or `kind: "cornerstone-webgpu"`.
- When `ms` is `null` (engine unavailable), `stages` MUST be undefined.

### Worker `"result"` message (EXTENDED)

Wire format in `src/engine/babylon/protocol.ts`; gains one optional field
on the `result` variant:

```ts
type FromWorker =
  | { type: "ready"; backend?: string; renderer?: string }
  | { type: "initError"; message: string }
  | { type: "imageSet" }
  | {
      type: "result";
      id: number;
      width: number;
      height: number;
      components: 1 | 3;
      min: number;
      max: number;
      elapsedMs: number;
      data: Float32Array;
      stages?: Omit<StageTimings, "roundTrip">;   // ← NEW — worker emits 4 of 5 stages
    }
  | { type: "error"; id?: number; message: string };
```

**Why `Omit<StageTimings, "roundTrip">`:** the worker has no visibility into
its own postMessage overhead — that's the gap between when the main thread
posted and when the main thread received the reply. `BabylonFilterEngine`
adds `roundTrip` on the main thread, producing the complete `StageTimings`
that lands in `FilterResult.stages`.

## Aggregation pipeline (per `BENCH_SAMPLES` loop in `App.tsx`)

For each Babylon engine that is available, the existing benchmark loop
already runs `BENCH_SAMPLES` (=7) iterations, discards the first as warmup,
and takes the median of the surviving `elapsedMs` values. This feature
extends the same loop:

1. Each iteration's `FilterResult` carries its own per-iteration `stages`
   (the `roundTrip` is filled by `BabylonFilterEngine` before the promise
   resolves, so by the time `App.tsx` sees the result, all five fields are
   present on Babylon rows).
2. The loop accumulates five parallel sample arrays (one per stage). It
   continues to discard the first sample of each (same warmup policy).
3. After the loop, each sample array is sorted and the middle element is
   picked — the per-stage median, computed independently from the
   `elapsedMs` median.
4. The five medians are bundled into a `StageTimings` object and attached
   to the row.

**Why per-stage median rather than median-of-totals-then-decomposed:**
because a single slow iteration can be slow for *different* reasons across
runs (e.g. a stutter that lengthens `compute` on one run and `readback` on
another). Per-stage median picks the typical cost of each stage
independently and is robust to that kind of cross-stage variability.

## Out-of-scope entities

- **CPU engine `StageTimings`**: not added. CPU `FilterResult.stages` stays
  `undefined`; the row renders no breakdown sub-cells (spec assumption).
- **Cornerstone row `StageTimings`**: not added. Cornerstone rows are
  windowing-only via `IMAGE_RENDERED` and don't decompose into the five
  Babylon-shaped stages (spec FR-005 + assumption).
- **Per-stage variance / min / max**: not surfaced in the UI for this
  feature. The breakdown ships medians only, matching the `ms / run`
  column's existing reporting model. If a future iteration wants
  whisker-plot style detail it can extend `StageTimings` rows without
  changing the contract here.
