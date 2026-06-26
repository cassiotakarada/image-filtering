# Data Model — Cornerstone WebGL + WebGPU Benchmark Rows

**Feature**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Date**: 2026-06-26

This feature touches a small, in-memory data surface — no persistence, no
external schemas, no migrations. Two entities are involved:

---

## E1. `BenchRow` (existing — widened)

Source-of-truth definition lives in [src/components/BenchmarkPanel.tsx](../../src/components/BenchmarkPanel.tsx).
The change is purely additive to the `kind` discriminator.

### Fields

| Field | Type | Notes |
|---|---|---|
| `kind` | `"babylon" \| "webgpu" \| "cpu" \| "cornerstone-webgl" \| "cornerstone-webgpu"` | **Widened.** Today's `"cornerstone"` value is removed (renamed to `"cornerstone-webgl"`) and `"cornerstone-webgpu"` is added. |
| `name` | `string` | Display label. New labels: `"Cornerstone (WebGL)"`, `"Cornerstone (WebGPU)"`. Other names unchanged. |
| `ms` | `number \| null` | Median ms over `BENCH_SAMPLES` runs, or `null` when the row is `n/a`. Unchanged semantically. |
| `note` | `string \| undefined` | Per-row caveat. Mandatory for both Cornerstone rows: WebGL keeps `"windowing only"`; WebGPU uses `"Cornerstone3D 4.15 has no WebGPU backend"` (or `"WebGPU not available"` if the browser itself lacks WebGPU — see R1 in research.md). |
| `backend` | `string \| undefined` | Backend tag shown in the "Backend" column. New rules: see "Backend tag values" below. |

### Backend tag values

| `kind` | Available | Unavailable |
|---|---|---|
| `"babylon"` | `"WebGL2"` / `"WebGL1"` | — (always available; CPU fallback not in this engine) |
| `"webgpu"` (Babylon-WebGPU) | `"WebGPU"` | `"WebGPU (unavailable)"` or `"WebGPU (shader compile failed)"` (existing strings from `BabylonWebGPUEngine.init()`) |
| `"cpu"` | `"JavaScript"` (existing) | n/a — always available |
| `"cornerstone-webgl"` | `"WebGL2"` / `"WebGL1"` from `cornerstoneBackend()` | `"no WebGL"` |
| `"cornerstone-webgpu"` | n/a — never available in CS3D 4.15 | `"WebGPU (no Cornerstone support)"` when `navigator.gpu` exists; `"WebGPU not available"` when it doesn't |

### Validation rules (enforced by spec, not by code)

- **VR-1 (FR-001):** the rows array MUST contain exactly one row of each
  of the five `kind` values per benchmark run.
- **VR-2 (FR-007a, SC-001):** the rows array's order MUST be:
  `babylon → cornerstone-webgl → webgpu → cornerstone-webgpu → cpu`.
- **VR-3 (FR-005):** for both Cornerstone rows, the rendered "vs CPU"
  column MUST be `—` (the comparable-engines check in `BenchmarkPanel`
  must NOT include either Cornerstone kind).
- **VR-4 (FR-007, FR-012):** `ms === null` MUST always coincide with a
  non-empty `note`. (The Cornerstone-WebGPU row exemplifies this every
  time; other rows hit it on environment failures.)

### State transitions

`BenchRow` is built-and-discarded per benchmark run. No transitions —
`runBenchmark()` constructs an empty array, appends rows in the order
above, then atomically `setBench(rows)`. The previous run's rows are
replaced wholesale.

---

## E2. `BenchViewport` (concept — internal to `cornerstoneSetup.ts`)

This is the implicit "thing" that owns the offscreen `<div>` +
`RenderingEngine` + `StackViewport` used to time Cornerstone renders. It
isn't a TypeScript type today — it's three module-level `let` bindings.
We document it here so the data shape is reviewable.

### Fields (effectively)

| Field | Type | Lifecycle |
|---|---|---|
| `benchElement` | `HTMLDivElement \| null` | Created lazily by `ensureBenchViewport()`. Inserted at fixed off-screen position (`position:fixed; left:-10000px`). Never removed in normal use. |
| `benchEngine` | `RenderingEngine \| null` | One per page session, paired with `benchElement`. Reused across runs. |
| `benchViewport` | `StackViewport` (typed as `any` today) | Single viewport on the engine. `setStack()` swaps source; `setProperties({ voiRange })` swaps window. |

### Relationships

- 1:1 with the WebGL bench (one viewport per page session).
- 0:0 with the WebGPU bench — **no equivalent viewport is created** in
  this iteration (the WebGPU row is a probe-only placeholder per R1).
  When upstream support lands, this is the natural extension point:
  add `benchElementWGPU` / `benchEngineWGPU` / `benchViewportWGPU` and a
  parallel `cornerstoneBenchRenderWebGPU()`.

### Validation rules

- **VR-5 (FR-008, SC-005):** the WebGL bench viewport MUST be reused
  across benchmark runs — no allocation per `runBenchmark()` invocation.
  Re-using is the existing behavior of `ensureBenchViewport()`; this rule
  prevents a future "fix" from accidentally re-creating it per run.
- **VR-6 (FR-009):** each `cornerstoneBenchSetSource(img)` call MUST
  register a fresh `source:bench-N` imageId and call `setStack([newId])`
  on the viewport before timing begins. This guarantees the row times
  the currently active source (synthetic at current size, or selected
  CT slice), not a stale prior source.

---

## Not modeled here

- `FilterEngine` / `FilterParams` / `FilterResult` — unchanged by this
  feature.
- The `store` Map in `cornerstoneSetup.ts` — unchanged structurally; just
  accumulates more `source:bench-N` entries (bounded; see research R3).
- The Cornerstone3D `RenderingEngine` / `StackViewport` types — these are
  external (`@cornerstonejs/core`) and out of scope for this data model.
