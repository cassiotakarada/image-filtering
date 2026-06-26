# Implementation Plan: Cornerstone WebGL + WebGPU Benchmark Rows

**Branch**: `001-cornerstone-engines` | **Date**: 2026-06-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-cornerstone-engines/spec.md`

## Summary

Replace today's single ambiguous `Cornerstone (GPU render)` benchmark row with
two explicit, backend-tagged rows — `Cornerstone (WebGL)` and `Cornerstone
(WebGPU)` — and lock the benchmark table to a constant 5-row, backend-grouped
layout (Babylon-WebGL, Cornerstone-WebGL, Babylon-WebGPU, Cornerstone-WebGPU,
CPU). Both WebGPU rows always render, displaying `n/a` + a reason note when the
backend isn't available, so reviewers can compare engines per-backend without
the "but which Cornerstone backend was that?" caveat.

**Technical approach (from research):** Cornerstone3D 4.15.21 has **no WebGPU
backend** — it renders through vtk.js on WebGL2 (falling back to WebGL1 / CPU).
The `Cornerstone (WebGL)` row therefore just relabels and tightens today's
working bench path. The `Cornerstone (WebGPU)` row is implemented as a
**permanent placeholder** that probes `navigator.gpu` for documentation purposes
and always emits an `n/a` row with the note `"Cornerstone3D 4.15 has no WebGPU
backend"`. This honestly surfaces the upstream limitation rather than faking a
number; if/when Cornerstone3D ships a WebGPU backend, the placeholder is the
single point that swaps to a real renderer.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), targeting ES2022 / browser ESM

**Primary Dependencies**:
- `@cornerstonejs/core` `^4.15.21` (WebGL2-only, see research.md)
- `@babylonjs/core` `^7.54.0` (already provides the WebGPU baseline for
  Babylon's row)
- `react` `^18.3.1`, `react-dom` `^18.3.1`
- `vite` `^6.0.5` (dev/build)

**Storage**: N/A — in-memory only; no persistence

**Testing**: No automated test runner (per constitution Development Workflow).
Verification is `tsc --noEmit` + `npm run build` + manual benchmark runs in a
browser (the constitution's "browser validation gap" applies — the spike
author runs no browser; reviewer runs are the runtime test stage).

**Target Platform**: Modern desktop browsers (Chrome 113+ / Edge 113+ for
WebGPU; any WebGL2 browser for the WebGL rows). Runs entirely client-side;
no server.

**Project Type**: Single-page web application (Vite + React). No frontend/
backend split.

**Performance Goals**: The Cornerstone-WebGL row's median ms MUST be within
~±20 % of today's `Cornerstone (GPU render)` row at the same phantom size
(this is just a relabel + tightening, not a perf change). Re-running the
benchmark 10× at 2048² MUST NOT grow DOM node count or GPU resource usage
(SC-005).

**Constraints**:
- Constitution Principle I (Engine Parity) is **partially relaxed** for
  Cornerstone rows by design — the existing `BenchmarkPanel` already documents
  that Cornerstone does "windowing only" and excludes those rows from the "vs
  CPU" speedup calc. This plan preserves that exemption explicitly (FR-005).
- Constitution Principle III (Display-Seam Isolation) — all changes live
  under `src/dicom/` and `src/components/` / `src/App.tsx`. `src/engine/`
  stays unchanged (no Cornerstone leak into the portable engine folder).
- Constitution Principle IV (Off-Main-Thread + Single Readback) — Cornerstone
  rows do not read back to CPU at all (canvas-only render); the timing
  boundary stays "set VOI → `render()` → `IMAGE_RENDERED` event", matching
  today's behavior. No new readbacks are introduced.
- Constitution Principle V (Synthetic-Data-Only) — no test fixtures added.

**Scale/Scope**: Two new source-level changes, both in
`src/dicom/cornerstoneSetup.ts` (the WebGL bench plumbing already exists —
this just tightens the label and renames the function) plus a placeholder
WebGPU bench function. UI wiring updates in `src/App.tsx` and
`src/components/BenchmarkPanel.tsx`. Documentation update in `README.md`.
Estimated file count touched: 4 source + 1 doc.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Initial gate (pre-research):**

| Principle | Status | Notes |
|---|---|---|
| I. Engine Parity | ✅ PASS | This feature explicitly does not touch the `FilterEngine` interface or the filter graph. Cornerstone rows have always been a separate, labeled "windowing-only" baseline (per `BenchmarkPanel` source comments and FR-005); this plan keeps that exemption visible. |
| II. Diagnostic Fidelity | ✅ PASS | Filter pipeline untouched. Cornerstone bench renders to a canvas with `setProperties({ voiRange })` — no 8-bit RGBA leak into the engines. |
| III. Display-Seam Isolation | ✅ PASS | All changes confined to `src/dicom/`, `src/components/`, `src/App.tsx`. `src/engine/` is not edited. The portable engine folder remains framework-agnostic. |
| IV. Off-Main-Thread + Single Readback | ✅ PASS (exempt) | Cornerstone bench rows do not perform readback (canvas-only display). The timing boundary stays the existing set-VOI → render → IMAGE_RENDERED event window. No new readbacks. |
| V. Synthetic-Data-Only | ✅ PASS | No test data added. Bench runs against the active in-app source (synthetic phantom by default; user-loaded CT when present, never committed). |
| Protected Branches (NON-NEGOTIABLE) | ✅ PASS | Work is on `001-cornerstone-engines`, branched from `bruno`. PR will target `bruno`. |

**Post-design re-check:** see end of Phase 1 below.

## Project Structure

### Documentation (this feature)

```text
specs/001-cornerstone-engines/
├── spec.md                                # /speckit.specify + /speckit.clarify output
├── plan.md                                # this file
├── research.md                            # Phase 0 — backend-selection research
├── data-model.md                          # Phase 1 — BenchRow + bench-viewport entities
├── quickstart.md                          # Phase 1 — reviewer verification steps
├── contracts/
│   └── benchmark-rows.md                  # UI contract (row set, order, n/a semantics)
├── checklists/
│   └── requirements.md                    # /speckit.specify quality check
└── tasks.md                               # /speckit.tasks output (NOT created here)
```

### Source Code (repository root)

This repo is a single-page web app (Vite + React). The existing layout is
preserved; this feature touches the marked files only.

```text
src/
├── App.tsx                                # MODIFIED — wire two cornerstone rows into runBenchmark + status timings
├── app.css                                # (unchanged)
├── main.tsx                               # (unchanged)
├── components/
│   ├── BenchmarkPanel.tsx                 # MODIFIED — extend BenchRow.kind union; update "vs CPU" comparable check; update hint text
│   └── Controls.tsx                       # (unchanged)
├── dicom/
│   ├── cornerstoneSetup.ts                # MODIFIED — rename WebGL bench fns + add WebGPU placeholder bench fns
│   ├── index.ts                           # MODIFIED — re-export new bench fn names
│   ├── loadDicomFiles.ts                  # (unchanged)
│   ├── decodeCompressed.ts                # (unchanged)
│   └── syntheticDicom.ts                  # (unchanged)
└── engine/                                # (UNCHANGED — display-seam isolation)
    ├── types.ts
    ├── babylon/
    └── cpu/

README.md                                  # MODIFIED — note 5-row benchmark + WebGPU placeholder rationale
```

**Structure Decision**: Single-project SPA. No tests/ directory (no
automated test runner in this spike, per constitution). The change-set is
deliberately small: 4 source files + README. No new directories, no new
modules.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(empty — all gates pass without justification)*

---

## Phase 0 — Outline & Research

**Output:** [research.md](./research.md)

Unknowns extracted from spec + Technical Context:

1. **Does Cornerstone3D 4.15.21 expose a WebGPU rendering backend?** —
   feeds FR-003 (force backend), FR-007 / FR-007a (n/a behavior), FR-012
   (WebGPU-absence note).
2. **How is Cornerstone3D's WebGL backend selected today?** — feeds FR-003
   ("forced WebGL") and FR-004 (backend tag values).
3. **What kills the offscreen bench viewport / leaks DOM on repeated runs?**
   — feeds FR-008 and SC-005.

All three are answered in `research.md` and inform the Phase 1 design below.
The headline finding: **Cornerstone3D 4.15 is WebGL2-only**, so the
`Cornerstone (WebGPU)` row is a documented placeholder, not a renderer. This
is explicitly accommodated by spec FR-012 and FR-007a, so no spec rewrite is
needed.

## Phase 1 — Design & Contracts

**Outputs:** [data-model.md](./data-model.md), [contracts/benchmark-rows.md](./contracts/benchmark-rows.md), [quickstart.md](./quickstart.md)

### 1. Entities — see [data-model.md](./data-model.md)

- `BenchRow` (existing) — `kind` union widens from
  `"babylon" | "webgpu" | "cpu" | "cornerstone"` to
  `"babylon" | "webgpu" | "cpu" | "cornerstone-webgl" | "cornerstone-webgpu"`.
- `BenchViewport` (concept, lives inside `cornerstoneSetup.ts`) — the existing
  module-level offscreen `<div>` + `RenderingEngine` + `StackViewport` triple,
  now treated as the single reusable WebGL bench viewport. No new viewport
  is created for WebGPU in this iteration (placeholder row only).

### 2. UI contract — see [contracts/benchmark-rows.md](./contracts/benchmark-rows.md)

The user-facing contract this feature exposes is the **benchmark table's row
set**: which rows appear, in what order, with what labels, and what they show
when a backend is unavailable. That contract is documented so any future
implementer (including a CSOI-Web port) can verify against the same surface.

### 3. Quickstart — see [quickstart.md](./quickstart.md)

A reviewer-runnable checklist: load the dev server, click **Run benchmark**,
verify the 5 rows are present in the correct order with correct backend tags
and `n/a`/note behavior on a non-WebGPU browser.

### 4. Agent context update

The [.github/copilot-instructions.md](../../.github/copilot-instructions.md)
SPECKIT block is updated to reference this plan file so agent runs in this
workspace see the active design.

---

### Constitution Check — Re-evaluation after Phase 1

Re-checking the same gates against the now-concrete design:

| Principle | Status | Post-design notes |
|---|---|---|
| I. Engine Parity | ✅ PASS | `src/engine/` untouched. Cornerstone rows still flagged "windowing only" with `vs CPU = —`. |
| II. Diagnostic Fidelity | ✅ PASS | No filter-pipeline change. Bench viewport's 8-bit canvas display path is unchanged from today. |
| III. Display-Seam Isolation | ✅ PASS | Confirmed: all edits in `src/dicom/`, `src/components/`, `src/App.tsx`. `src/engine/` zero diff. |
| IV. Off-Main-Thread + Single Readback | ✅ PASS | Cornerstone bench is canvas-only display, zero readback. WebGPU placeholder does not even render — no GPU work at all in this iteration. |
| V. Synthetic-Data-Only | ✅ PASS | No data fixtures added. |
| Protected Branches | ✅ PASS | On `001-cornerstone-engines`; PR will target `bruno`. |

**Gate status: PASS — no Complexity Tracking entries needed.**

---

## Done When (Phase 2 prerequisites met)

- [x] Plan workflow executed; Phase 0 research generated and unknowns resolved.
- [x] Phase 1 design artifacts generated: `research.md`, `data-model.md`,
      `quickstart.md`, `contracts/benchmark-rows.md`.
- [x] Agent context updated.
- [x] Constitution Check passes both pre- and post-design.

Next: run `/speckit.tasks` on this branch to generate `tasks.md`.
