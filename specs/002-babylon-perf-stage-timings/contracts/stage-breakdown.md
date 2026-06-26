# UI + Engine Contract — Babylon Per-Stage Timing Breakdown

**Feature**: `002-babylon-perf-stage-timings`
**Inputs**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](../data-model.md)

This document is the **stable surface** other implementers (including a
future CSOI-Web port) verify against. Source layout, function names, and
engine internals may change; the items below MUST NOT change without
amending this contract.

## C-1 — Stage names, units, and inclusion/exclusion rules

Five stages, ordered as they execute inside one `run()` call:

| Stage        | Included                                                                                                  | Excluded                                                                                  | Engine-side measurement                                              |
|--------------|-----------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| `compile`    | The wait observed inside `run()` for the filter shader to become ready (`proc.isReady()` polling).        | Engine `init()` cost; shader compile that happened before `run()` started.                | `t_after_isReady - t_run_start`. `0` when warm.                      |
| `upload`     | All per-run uniform setters (`setVector2`, `setFloat`, `setTexture`), CLAHE map texture build+bind when CLAHE > 0, LUT swap. | `setImage()` source upload; engine-init texture creation.                                  | `t_after_uniforms - t_after_isReady`.                                |
| `compute`    | `proc.render()` only (the GPU command-submit call).                                                       | The GPU sync triggered by the subsequent readback.                                         | `t_after_render - t_after_uniforms`.                                 |
| `readback`   | `await proc.readPixels()` — the awaited promise, including the implicit GPU sync that resolves it.        | The CPU-side un-interleave loop that converts RGBA float to grayscale or RGB.              | `t_after_readPixels - t_after_render`.                               |
| `roundTrip`  | Main-thread wall-clock around `postMessage("run") → onmessage("result")` *minus* the worker's reported `elapsedMs`. | Anything inside the engine's `run()`.                                                      | `max(0, (t_recv - t_send) - worker.elapsedMs)`. `0` on main-thread engines. |

**Unit:** milliseconds (matching the existing `elapsedMs` field), reported
to two decimal places.

**Identity for unused stages:** A stage value of `0` means "observed and
contributed no measurable time". *Absence of the whole `stages?` field*
means "this engine does not decompose into these stages" (CPU and any
future single-pass engine).

## C-2 — Sub-row UI layout under each Babylon row

The benchmark table from spec 001 stays at exactly **five rows in this
locked order**:

1. Babylon (WebGL, worker)
2. Cornerstone (WebGL)
3. Babylon (WebGPU, main thread)
4. Cornerstone (WebGPU)
5. CPU (main thread)

This feature adds **five sub-cells** under each of rows #1 and #3 (the two
Babylon rows). Rows #2, #4, #5 are unchanged.

The sub-cells render as a compact secondary line under the row's existing
`Engine | Backend | ms / run | vs CPU` line. Suggested rendering (any
visually equivalent layout that preserves the columns is acceptable):

```text
| Engine                              | Backend | ms / run | vs CPU |
|-------------------------------------|---------|----------|--------|
| Babylon (WebGL, worker)             | WebGL2  |   122.00 |  4.3×  |
|   ↳ compile 0.00 · upload 1.23 · compute 0.45 · readback 115.10 · round-trip 5.22                |
| Cornerstone (WebGL)                 | WebGL2  |     4.60 |   —    |
| Babylon (WebGPU, main thread)       | WebGPU  |   285.70 |  1.8×  |
|   ↳ compile 0.00 · upload 0.88 · compute 1.10 · readback 283.50 · round-trip 0.00                |
| Cornerstone (WebGPU)  · n/a         | …       |      n/a |   —    |
| CPU (main thread)                   | JS      |   519.70 |  base  |
```

**Render rules:**

- When `BenchRow.stages` is present, render the five stage values in the
  fixed order `compile, upload, compute, readback, roundTrip` with
  two-decimal ms precision.
- When `BenchRow.stages` is absent on a Babylon row (`ms` is `null` — engine
  unavailable), render the sub-line as `—` or omit it; do not render
  zeros.
- For non-Babylon rows the sub-line MUST NOT be rendered at all. The locked
  row order is preserved verbatim.

## C-3 — Reconciliation tolerance

For each Babylon row where `BenchRow.ms` and `BenchRow.stages` are both
present, the following MUST hold:

```text
|(compile + upload + compute + readback) - ms| ≤ max(1.0, 0.05 * ms)
```

(In English: the four engine-internal stages must sum to within the larger
of 1 ms or 5 % of the row's `ms / run`. `roundTrip` is intentionally not
in this sum — it measures time that lives *outside* the engine's `elapsedMs`
span.)

**Violation handling:** A reviewer-noticeable gap is a defect, not a UI
flag. The contract is enforced by the reviewer browser walk (quickstart
step 5) and by code review of `App.tsx`'s aggregation — not by a runtime
assertion that would gate the benchmark from displaying. The benchmark MUST
still render usable numbers even when the gap is large; the gap is a
debugging signal, not a hard failure.

## C-4 — Row-set preservation

The five-row, backend-grouped layout from spec 001's contract `C-2`
(`specs/001-cornerstone-engines/contracts/benchmark-rows.md`) is preserved
**verbatim** by this feature. Stage breakdown is an addition under the two
Babylon rows; it does not:

- add, remove, reorder, or rename any of the five top-level rows;
- change the `ms / run` value on any row;
- change which rows participate in the `vs CPU` speedup column (still only
  the two Babylon rows; see spec 001 `FR-005`);
- change the `n/a` + note behavior of the Cornerstone (WebGPU) placeholder
  row (still `n/a`, still notes the Cornerstone3D 4.15 WebGPU absence).

## C-5 — Hint paragraph (text contract)

The `<p className="hint">` paragraph at the bottom of `BenchmarkPanel` MUST
be updated to:

1. Define the five stage names in one or two short sentences each.
2. Explain why CPU and Cornerstone rows do not show the breakdown (CPU is
   a single synchronous pass; Cornerstone does windowing only via
   `IMAGE_RENDERED` and doesn't decompose into the Babylon-shaped stages).
3. Preserve the spec-001 note about the Cornerstone (WebGPU) placeholder
   row and the "windowing only" disclaimer.

The exact wording is at implementer discretion provided the three items
above are present and a reviewer with no prior context can read the panel
and interpret every column.

## Verification

| Item       | How verified                                                                                       |
|------------|----------------------------------------------------------------------------------------------------|
| C-1        | Code inspection of `babylon.worker.ts`, `BabylonWebGPUEngine.ts`, `BabylonFilterEngine.ts` against the table above. |
| C-2        | Reviewer browser walk (quickstart step 3) — visual check that both Babylon rows show five sub-cells in the listed order. |
| C-3        | Reviewer browser walk (quickstart step 5) — compute `sum - ms` for each Babylon row; record. |
| C-4        | Reviewer browser walk (quickstart step 4) — visual check that the row order matches spec 001 C-2 exactly. |
| C-5        | Reviewer reads the hint paragraph in the panel and confirms all three items above are present.    |

## Non-goals (out of contract)

- This contract does not constrain the implementation of the per-stage
  median accumulation in `App.tsx`. Any algorithm that produces the same
  observable values is acceptable.
- This contract does not constrain whether the sub-cell layout is a second
  table row, a flex line, or a tooltip — only that the five values render
  in order with two-decimal precision when `stages?` is present.
- This contract does not require GPU timer queries (`EXT_disjoint_timer_
  query_webgl2` etc.). Timing is wall-clock at JS boundaries by design.
