# Feature Specification: Cornerstone WebGL + WebGPU Benchmark Rows

**Feature Branch**: `001-cornerstone-engines`

**Created**: 2026-06-26

**Status**: Draft

**Input**: User description: "add cornerstone with webGL and cornerstone with webGPU to our benchmarks"

## Clarifications

### Session 2026-06-26

- Q: Row order in the benchmark table once both Cornerstone rows exist? → A: Backend-grouped, CPU last — Babylon-WebGL, Cornerstone-WebGL, Babylon-WebGPU, Cornerstone-WebGPU, CPU.
- Q: How should the table behave on a browser without WebGPU? → A: Always show both WebGPU rows with `n/a` + reason note (constant table layout across environments); applies to Babylon-WebGPU and Cornerstone-WebGPU alike.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explicit Cornerstone WebGL row in the benchmark (Priority: P1)

A reviewer evaluating the spike opens the benchmark panel, runs a benchmark on
the current phantom + filter settings, and sees a row that unambiguously
reports Cornerstone3D's window/level render time **forced to its WebGL
backend**, with the backend column reading "WebGL2" (or "WebGL1" / "no WebGL"
when that's all the browser exposes). This replaces today's ambiguous
"Cornerstone (GPU render)" row, which just reports whatever Cornerstone
happened to pick.

**Why this priority**: The spike's headline question — "do we need a separate
Babylon engine at all, or is Cornerstone's own GPU windowing already fast
enough?" — depends on a labeled, reproducible Cornerstone baseline. Without
it, every benchmark conversation gets sidetracked by "but which Cornerstone
backend was that?" This is the minimum-useful slice and ships value on its
own.

**Independent Test**: With `BabylonWebGPUEngine` and the Cornerstone WebGPU
row both disabled (or simply not yet implemented), the benchmark still runs,
displays a clearly labeled `Cornerstone (WebGL)` row with a median ms value
and a backend tag, and the explanatory hint under the table still reads
correctly.

**Acceptance Scenarios**:

1. **Given** the app is loaded and the phantom is shown,
   **When** the user clicks **Run benchmark**,
   **Then** the benchmark table includes a row whose engine label is
   `Cornerstone (WebGL)`, whose backend column shows the detected WebGL
   version, whose ms column shows a median, and whose "vs CPU" column shows
   `—` with the existing "windowing only" caveat preserved.
2. **Given** the benchmark has been run,
   **When** the user changes filter sliders and re-runs the benchmark,
   **Then** the `Cornerstone (WebGL)` row updates with the new median and the
   row's caveat note ("windowing only") remains visible.
3. **Given** a browser without WebGL support (or one where Cornerstone's
   WebGL init throws),
   **When** the user runs the benchmark,
   **Then** the `Cornerstone (WebGL)` row appears with `n/a` in the ms column
   and a short failure note, and the rest of the benchmark still completes.

---

### User Story 2 - Cornerstone WebGPU row alongside it (Priority: P2)

The same reviewer, on a WebGPU-capable browser, sees a second Cornerstone row
labeled `Cornerstone (WebGPU)` reporting the median ms of the **same**
window/level operation run through Cornerstone3D's WebGPU backend. The two
Cornerstone rows sit next to each other in the table, mirroring the existing
Babylon WebGL / Babylon WebGPU pairing.

**Why this priority**: This is what makes the benchmark a fair "Cornerstone
vs Babylon" comparison across both graphics backends. It's P2 (not P1)
because Cornerstone3D's WebGPU path is experimental upstream and might not
initialize on every machine — the spike must still ship a meaningful result
when only WebGL is available, which US1 already delivers.

**Independent Test**: With US1 already merged, on a WebGPU-capable browser
the benchmark shows both `Cornerstone (WebGL)` and `Cornerstone (WebGPU)`
rows with separate medians; on a non-WebGPU browser the WebGPU row appears
with `n/a` ms and a short reason, and the WebGL row is unaffected.

**Acceptance Scenarios**:

1. **Given** a WebGPU-capable browser and a successful one-time Cornerstone
   WebGPU init,
   **When** the user clicks **Run benchmark**,
   **Then** the table contains both a `Cornerstone (WebGL)` row and a
   `Cornerstone (WebGPU)` row, each with its own median ms and its own
   backend tag ("WebGL2" and "WebGPU" respectively).
2. **Given** a browser without WebGPU,
   **When** the user runs the benchmark,
   **Then** the `Cornerstone (WebGPU)` row is present with `n/a` ms and a
   note like "WebGPU not available", and the `Cornerstone (WebGL)` row still
   reports its median normally.
3. **Given** Cornerstone's WebGPU rendering engine init or first render
   throws an error,
   **When** the user runs the benchmark,
   **Then** the `Cornerstone (WebGPU)` row is present with `n/a` ms and the
   error message as the note; the other engines' rows are unaffected.

---

### Edge Cases

- The user changes the phantom size (512² / 1024² / 2048²) between benchmark
  runs: the next benchmark MUST re-time both Cornerstone rows against the new
  source without leaking state from the previous size (no stale viewport, no
  stale source registration).
- The user loads real CT slices and switches between them: both Cornerstone
  rows MUST benchmark against the *currently active* source, not the original
  synthetic phantom.
- WebGPU init takes noticeably longer than WebGL: a slow first-render on the
  WebGPU row MUST NOT skew the row's median (the existing warmup discard
  pattern applies to both rows).
- The user re-runs the benchmark many times in succession: neither Cornerstone
  row may accumulate offscreen viewport elements, listeners, or rendering
  engines (leak-free across runs, same as today's single-row behavior).
- The Babylon WebGPU engine and the Cornerstone WebGPU row are both
  unavailable on the same browser: the table makes it visually obvious that
  the missing rows are an environment limit, not a benchmark bug.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The benchmark MUST report two distinct Cornerstone rows per
  run — one labeled `Cornerstone (WebGL)` and one labeled `Cornerstone
  (WebGPU)` — replacing today's single combined row.
- **FR-002**: Each Cornerstone row MUST measure the same operation it
  measures today (set VOI → render → IMAGE_RENDERED event), so the two rows
  are directly comparable to each other and to the existing rows.
- **FR-003**: Each Cornerstone row MUST be timed using a Cornerstone3D
  rendering engine **forced** to the row's target backend (WebGL for the
  first row, WebGPU for the second). The previous behavior of "whatever
  Cornerstone picks" is no longer acceptable.
- **FR-004**: Each Cornerstone row MUST display a backend tag in the
  benchmark table's existing "Backend" column. WebGL rows show the WebGL
  version detected ("WebGL2", "WebGL1", or "no WebGL"); WebGPU rows show
  "WebGPU" when active.
- **FR-005**: Each Cornerstone row MUST preserve the existing "windowing
  only" caveat note, and the "vs CPU" column for both rows MUST remain `—`
  (not a fake speedup against the full-pipeline CPU number).
- **FR-006**: When the WebGL row's underlying rendering engine cannot be
  initialized OR its render throws, that row MUST still appear in the
  table with `n/a` ms and a short failure note. The WebGPU row's success
  and the other engines' rows MUST NOT be affected.
- **FR-007**: When the WebGPU row's underlying rendering engine cannot be
  initialized (no WebGPU, init throws, first render throws), that row MUST
  still appear in the table with `n/a` ms and a short failure note (e.g.,
  "WebGPU not available"). The WebGL row and the other engines' rows MUST
  NOT be affected.
- **FR-007a**: The benchmark table's row set MUST be constant across
  environments — every benchmark run produces exactly the same row labels in
  the same order regardless of whether WebGL2/WebGPU are available. This
  applies symmetrically to both WebGPU rows (`Babylon (WebGPU)` and
  `Cornerstone (WebGPU)`): a missing backend produces `n/a` + a reason note,
  never a hidden row. This extends today's behavior — which already emits
  `ms:null` rows for unavailable Babylon engines — to cover the new
  `Cornerstone (WebGPU)` row symmetrically.
- **FR-008**: Successive benchmark runs MUST be leak-free: the WebGL and
  WebGPU bench viewports, rendering engines, listeners, and source
  registrations MUST be re-usable (or properly torn down and rebuilt)
  without unbounded DOM, GPU resource, or memory growth.
- **FR-009**: Both Cornerstone rows MUST benchmark against the *currently
  active* source (synthetic phantom at current size, or the selected real CT
  slice) — not a stale source from a previous size or slice.
- **FR-010**: The benchmark warmup pattern (run once, discard, then sample
  N times and take the median) MUST apply identically to every Cornerstone
  row that emits a non-null `ms`. The number of samples used is the existing
  `BENCH_SAMPLES` constant. Documented placeholder rows that always emit
  `ms: null` (e.g., the `Cornerstone (WebGPU)` row per FR-012) are exempt
  because no timing is performed.
- **FR-011**: The explanatory hint under the benchmark table MUST be
  updated to reflect that there are now two Cornerstone rows and explain
  why they may differ in performance while still measuring the same logical
  operation.
- **FR-012**: When Cornerstone3D does not expose a usable WebGPU backend in
  the project's pinned Cornerstone3D version, that fact MUST be surfaced in
  the WebGPU row's failure note (rather than silently omitting the row or
  failing the whole benchmark).

### Key Entities *(include if feature involves data)*

- **Cornerstone bench viewport**: An offscreen `<div>` plus a
  `RenderingEngine`-driven `StackViewport`, dedicated to benchmark timing
  and reused across runs. **One instance for the WebGL row only**; the
  WebGPU row is a probe-only placeholder (no viewport allocated) until
  Cornerstone3D ships a WebGPU backend — see [research.md](./research.md) R1
  and [data-model.md](./data-model.md) E2.
- **Benchmark row**: The existing `BenchRow` structure (kind / name /
  backend / ms / note). The set of `kind` values expands from
  `babylon | webgpu | cpu | cornerstone` to include both
  `cornerstone-webgl` and `cornerstone-webgpu` (or equivalent), so the
  rendering layer can render them as distinct rows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After running **Run benchmark** on a fresh load, the benchmark
  table shows **exactly five rows** in this order: Babylon-WebGL,
  Cornerstone-WebGL, Babylon-WebGPU, Cornerstone-WebGPU, CPU. On browsers
  that don't support WebGPU, both WebGPU rows still appear with `n/a` ms +
  a reason note; the row set is constant across environments.
- **SC-002**: On any single browser, every row's backend tag unambiguously
  identifies which graphics path it actually exercised — a reviewer can
  answer "which WebGL/WebGPU stack produced this number?" without reading
  the source. WebGPU rows with `n/a` show the reason note instead of a
  backend tag.
- **SC-003**: Removing one Cornerstone backend (e.g., disabling WebGPU at
  the browser flag level) MUST NOT prevent the other Cornerstone row from
  reporting a valid median, and MUST NOT abort the benchmark. The remaining
  rows complete in the same wall-clock window as today.
- **SC-004**: A reviewer comparing Babylon (WebGL) vs Cornerstone (WebGL)
  at the same phantom size sees apples-to-apples backends in the "Backend"
  column for both rows, making the cross-engine comparison interpretable
  without the existing "but which Cornerstone backend?" caveat.
- **SC-005**: Re-running the benchmark **10 times in a row** at the largest
  phantom size (2048²) does not produce unbounded growth in the page's DOM
  node count or GPU resource usage (no slow leak from per-backend bench
  viewports).

## Assumptions

- Cornerstone3D's pinned version in this repo (`^4.15.21`) exposes a path to
  force its rendering engine onto a specific backend (WebGL vs WebGPU). If
  it doesn't — or its WebGPU path isn't yet stable enough to render the
  synthetic phantom — that's a known runtime risk: it surfaces via FR-012
  (WebGPU row shows `n/a` + a clear note) and is documented in `README.md`
  alongside the existing runtime risks, not by blocking the feature.
- Both Cornerstone rows continue to measure **windowing only** — the
  "windowing only" caveat stays; this feature is not about extending
  Cornerstone's filter capability, only about labeling its graphics
  backends explicitly.
- The benchmark stays single-source per run (no need to bench across
  multiple slices simultaneously). The active source at the moment **Run
  benchmark** is clicked is what both Cornerstone rows time against.
- The visual ordering in the benchmark table is **backend-grouped, CPU
  last**: Babylon-WebGL, Cornerstone-WebGL, Babylon-WebGPU,
  Cornerstone-WebGPU, CPU. This keeps WebGL-vs-WebGL and WebGPU-vs-WebGPU
  comparisons visually adjacent, and keeps CPU at the bottom as the
  speedup-baseline anchor.
- The synthetic-data-only constraint from the constitution is unchanged:
  benchmarks may run against real CT slices the user loads locally, but no
  such data is added to the repository.
