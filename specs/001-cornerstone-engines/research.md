# Phase 0 Research — Cornerstone WebGL + WebGPU Benchmark Rows

**Feature**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Date**: 2026-06-26

This document resolves the three unknowns flagged by `plan.md` Technical
Context. Each item follows the **Decision / Rationale / Alternatives
considered** structure required by the plan workflow.

---

## R1. Does Cornerstone3D 4.15.21 expose a WebGPU rendering backend?

**Question:** The spec assumes (Assumptions section) that Cornerstone3D
exposes a path to force its rendering engine onto WebGPU vs WebGL. Does it?

**Decision: No. Cornerstone3D 4.15.21 is WebGL2-only.** The `Cornerstone
(WebGPU)` benchmark row in this feature is implemented as a documented
placeholder that always reports `n/a` with the note
`"Cornerstone3D 4.15 has no WebGPU backend"`.

**Rationale (evidence):**

Reading `packages/core/src/init.ts` at the
[v4.15.21 tag](https://github.com/cornerstonejs/cornerstone3D/blob/v4.15.21/packages/core/src/init.ts):

- The init config (`Cornerstone3DConfig.rendering`) exposes
  `useCPURendering`, `preferSizeOverAccuracy`, `renderingEngineMode`
  (`ContextPool` | `tiled`), `webGlContextCount`, and `volumeRendering`
  options. **There is no WebGPU-related option.**
- `_getGLContext()` probes the canvas in exactly this order:
  `webgl2 → webgl → experimental-webgl`. There is no `navigator.gpu` /
  `requestAdapter` path anywhere in the init logic.
- `_hasActiveWebGLContext()` returns boolean; if false, init logs
  `"CornerstoneRender: GPU not detected, using CPU rendering"` and sets
  `useCPURendering = true`. The branching is binary: WebGL or CPU. No
  third (WebGPU) branch exists.
- The 4.15.21 line's rendering still flows through vtk.js's
  `OpenGLRenderWindow`. There is no `WebGPURenderWindow` in this version.

**Implication for FR-003 / FR-007 / FR-012:**

- FR-003 ("Cornerstone3D rendering engine **forced** to the row's target
  backend") is satisfied for the WebGL row by the fact that Cornerstone3D
  4.15's only GPU backend **is** WebGL — there is no other backend to
  accidentally select. The "forced WebGL" requirement is satisfied
  structurally by the dependency itself.
- FR-007 ("WebGPU row's underlying rendering engine cannot be
  initialized") and FR-012 ("when Cornerstone3D does not expose a usable
  WebGPU backend, surface that fact in the WebGPU row's failure note")
  together mean the WebGPU row's runtime behavior is **always** the
  failure path. The implementation is a probe that returns `n/a` + the
  documented reason note.

**Alternatives considered:**

- *Hide the `Cornerstone (WebGPU)` row entirely until upstream support
  lands.* Rejected: FR-007a (locked in via clarification Q2) requires a
  constant row set across environments. Hiding it would also remove the
  documentation value — reviewers wouldn't know whether the spike author
  forgot to add it or whether Cornerstone3D doesn't support it.
- *Bench an alternative WebGPU stack (e.g., vtk.js's WebGPU experimental
  branch or a third-party WebGPU DICOM viewer) and label it as
  "Cornerstone (WebGPU)".* Rejected: the row's name claims a specific
  identity. Mis-attributing a non-Cornerstone WebGPU number would
  violate Principle I (Engine Parity) — reviewers couldn't trust the
  comparison.
- *Wait for Cornerstone3D 5.x or a future WebGPU PR.* Rejected: the
  spike's purpose is to evaluate today's stack against Babylon. The
  honest "no backend yet" answer is itself part of the evidence.
- *Use `cornerstone-webgl-render-loop` or another upstream experiment.*
  Investigated via `cornerstonejs/cornerstone3D` repo issues; no stable
  WebGPU module exists at v4.15.21.

---

## R2. How is Cornerstone3D's WebGL backend selected today?

**Question:** FR-003 requires "forced" WebGL for the WebGL row. Given R1's
finding, what does "forced" mean here mechanically?

**Decision:** Use Cornerstone3D's default init (`csRenderInit()`) and
ensure WebGL2 is the actually-selected context by:

1. Calling `cornerstoneBackend()` (existing helper in
   `src/dicom/cornerstoneSetup.ts`) which probes a throwaway canvas for
   `webgl2` then `webgl` and returns `"WebGL2"` / `"WebGL1"` / `"no WebGL"`.
2. Surfacing that string as the row's `backend` tag.

Because Cornerstone3D 4.15 has no other GPU backend, this **is** "forced
WebGL". The label is honest about which WebGL version was selected.

**Rationale:** The existing `cornerstoneBackend()` helper (lines 295–308
of `cornerstoneSetup.ts`) was written specifically because Cornerstone3D
blits its offscreen WebGL2 surface to a 2D canvas, so probing the
viewport canvas finds a 2D context. The throwaway-canvas probe is the
correct way to detect the WebGL stack Cornerstone is actually using.

**Alternatives considered:**

- *Inspect the vtk.js render window directly to read its WebGL version.*
  Rejected: brittle (uses private vtk.js internals); the throwaway-canvas
  probe gives the same answer and survives Cornerstone version bumps.
- *Pass an explicit "useWebGL2" flag through Cornerstone's init config.*
  Rejected: no such flag exists in 4.15.21 (see R1). The only related
  knob is `useCPURendering`, which is the opposite of what we want.

---

## R3. What prevents the offscreen bench viewport from leaking on repeated runs?

**Question:** SC-005 requires re-running the benchmark 10× at 2048²
without unbounded DOM / GPU resource growth. The current implementation
creates one offscreen `<div>` + `RenderingEngine` + `StackViewport` lazily
on first bench call (`ensureBenchViewport()`) and reuses them. Is that
safe?

**Decision: Yes — keep the existing module-level singleton pattern.** No
teardown is needed between runs because `setStack([imageId])` replaces the
viewport's stack atomically and `setProperties({ voiRange })` mutates the
existing viewport without allocating new GPU resources.

**Rationale:**

- The bench viewport is a module-level singleton (`benchElement`,
  `benchEngine`, `benchViewport` in `cornerstoneSetup.ts`). It's created
  exactly once per page load.
- Each `cornerstoneBenchSetSource()` call increments the source counter
  and registers a new `source:bench-N` image, then calls `setStack()` —
  but the **viewport** is reused. `setStack` swaps the image reference; it
  doesn't allocate a new `<canvas>` or WebGL context.
- The `IMAGE_RENDERED` event listener in `cornerstoneBenchRender()` is
  removed in `finish()` (both the success path and the 1-second timeout).
  No listener accumulation.
- The `source:bench-N` entries accumulate in the `store` Map across runs.
  At ~100 bytes/entry of metadata + the typed-array reference, 10 runs ×
  ~10 samples = ~100 entries = trivially bounded. The typed arrays
  themselves are the same buffer reused (the source `ImageBuffer` is
  passed by reference to `cornerstoneBenchSetSource`).
- For the WebGPU placeholder row: it does no rendering at all, so it
  contributes zero DOM / GPU resources.

**Implication for FR-008:** the existing structure already satisfies it
for the WebGL row. The WebGPU row's placeholder also satisfies it
trivially (no resources allocated). No new bench-viewport plumbing is
needed in this iteration.

**Alternatives considered:**

- *Tear down and re-create the bench viewport between runs to ensure a
  clean state.* Rejected: would dominate the per-sample time
  (rendering-engine init is ~tens of ms), inflating the medians, and the
  evidence above shows there's nothing to clean.
- *Garbage-collect the `source:bench-N` entries from `store` after each
  bench run.* Rejected: 10–100 entries per page session is well under any
  meaningful memory threshold; the cost of bookkeeping isn't justified.
  Optional follow-up if real-CT bench runs change this calculus.

---

## Cross-cutting summary

The three findings collapse into a single concrete design:

1. **WebGL row** (`kind: "cornerstone-webgl"`) — relabel + slight tightening
   of today's working `Cornerstone (GPU render)` row. Uses the existing
   bench viewport (R3) and reports `cornerstoneBackend()` (R2) as the tag.
2. **WebGPU row** (`kind: "cornerstone-webgpu"`) — always emits an `n/a`
   row with the documented reason note from R1. Implemented as a tiny
   probe that returns `{ ms: null, note: "Cornerstone3D 4.15 has no WebGPU
   backend", backend: navigator.gpu ? "WebGPU (no Cornerstone support)" :
   "WebGPU not available" }`. The two distinct backend tags help reviewers
   distinguish "browser lacks WebGPU" from "Cornerstone lacks the backend".

No `NEEDS CLARIFICATION` markers remain. Plan is ready for Phase 1
design artifacts.
