# Tasks: Cornerstone WebGL + WebGPU Benchmark Rows

**Feature**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Branch**: `001-cornerstone-engines`

**Input**: Design documents from `specs/001-cornerstone-engines/`

**Prerequisites**:

- [plan.md](./plan.md) ✓
- [spec.md](./spec.md) ✓
- [research.md](./research.md) ✓
- [data-model.md](./data-model.md) ✓
- [contracts/benchmark-rows.md](./contracts/benchmark-rows.md) ✓
- [quickstart.md](./quickstart.md) ✓

**Tests**: NOT requested. Per constitution Development Workflow, this spike has
no automated test runner. Validation is `npm run build` (tsc + vite) + manual
reviewer run via [quickstart.md](./quickstart.md). No test tasks are generated.

**Organization**: Tasks are grouped by user story to enable independent
implementation and delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization.

**This phase is empty for this feature.** The Vite + React + TypeScript
project, the Cornerstone3D dependency, the Babylon engines, and the existing
bench-viewport singleton in `cornerstoneSetup.ts` are all already in place.
Nothing new to scaffold.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Widen the shared `BenchRow.kind` discriminator union so both
user stories can construct rows of the new kinds without TypeScript errors,
and preserve the "comparable engines" contract (Cornerstone rows excluded
from "vs CPU" speedup ratio).

**⚠️ CRITICAL**: Both user stories depend on this phase. No US1/US2 work can
land until T001 is complete.

- [X] T001 Narrow [`BenchRow.kind`](src/components/BenchmarkPanel.tsx) from `string` to the literal union `"babylon" | "webgpu" | "cpu" | "cornerstone-webgl" | "cornerstone-webgpu"` in [src/components/BenchmarkPanel.tsx](src/components/BenchmarkPanel.tsx); update the JSDoc to list the five values; leave the `comparable` check (`r.kind === "babylon" || r.kind === "webgpu"`) unchanged — it already excludes both new Cornerstone kinds, satisfying VR-3 / C-5

**Checkpoint**: Foundation ready — both user stories can now begin in parallel.

---

## Phase 3: User Story 1 — Explicit Cornerstone WebGL row (Priority: P1) 🎯 MVP

**Goal**: Replace today's ambiguous `Cornerstone (GPU render)` row with an
explicit `Cornerstone (WebGL)` row that reports the detected WebGL version
("WebGL2" / "WebGL1" / "no WebGL") in the Backend column, in its locked
slot (#2: after `Babylon (WebGL, worker)`, before `Babylon (WebGPU, main
thread)`).

**Independent Test**: Reviewer opens the app, clicks **Run benchmark**, and
sees a row labeled `Cornerstone (WebGL) · windowing only` with a real median
ms, a backend tag like `WebGL2`, and `—` in the "vs CPU" column.
Per-quickstart.md sections "Verification on a WebGPU-capable browser" steps
1–2 (rows 1, 2, 5 populated) — verifiable independently of US2.

### Implementation for User Story 1

- [X] T002 [US1] Rename WebGL bench helpers in [src/dicom/cornerstoneSetup.ts](src/dicom/cornerstoneSetup.ts): `cornerstoneBenchSetSource` → `cornerstoneBenchSetSourceWebGL` and `cornerstoneBenchRender` → `cornerstoneBenchRenderWebGL` (no functional change; leaves the existing `ensureBenchViewport()` singleton — VR-5 — intact)
- [X] T003 [US1] Update [src/dicom/index.ts](src/dicom/index.ts) re-exports to use the new helper names from T002
- [X] T004 [US1] In [src/App.tsx](src/App.tsx), update the imports from `./dicom` to the new helper names (`cornerstoneBenchSetSourceWebGL`, `cornerstoneBenchRenderWebGL`)
- [X] T005 [US1] In [src/App.tsx](src/App.tsx) `runBenchmark`, replace the trailing `kind: "cornerstone"` row construction with `kind: "cornerstone-webgl"`, label `"Cornerstone (WebGL)"`, keep `note: "windowing only"` on success, keep `backend: cornerstoneBackend()`, and ensure the failure path also emits `kind: "cornerstone-webgl"` with `backend: cornerstoneBackend()` so the row is always present (FR-006, C-3)

**Checkpoint**: US1 complete — running the benchmark on any WebGL-capable
browser produces a `Cornerstone (WebGL)` row in its labeled slot. The
benchmark still ships a meaningful result independently of US2.

> **Note**: After US1 alone, the table will not yet have row #4
> (`Cornerstone (WebGPU)`) and the rows won't yet be in the backend-grouped
> order from C-2 (US1 leaves the WebGL Cornerstone row appended at the end
> as today). US2 lands both the new row and the final ordering.

---

## Phase 4: User Story 2 — Cornerstone WebGPU placeholder row (Priority: P2)

**Goal**: Add a permanent `Cornerstone (WebGPU)` row that always emits
`ms: null` plus the documented reason note (`"Cornerstone3D 4.15 has no
WebGPU backend"` when `navigator.gpu` is defined; `"WebGPU not available"`
otherwise) — per research R1 and contract C-9 — and lock the final
backend-grouped row order from C-2.

**Independent Test**: With US1 already merged, the benchmark table shows
exactly five rows in the order `Babylon (WebGL, worker)` →
`Cornerstone (WebGL)` → `Babylon (WebGPU, main thread)` →
`Cornerstone (WebGPU)` → `CPU (JavaScript)`. The Cornerstone-WebGPU row
shows `n/a` with the documented note on **every** environment (WebGPU or
not) — quickstart.md "Verification on a WebGPU-capable browser" step 3 +
"Verification on a WebGL-only / no-WebGPU browser" step 3.

### Implementation for User Story 2

- [X] T006 [US2] Add `cornerstoneBenchProbeWebGPU()` in [src/dicom/cornerstoneSetup.ts](src/dicom/cornerstoneSetup.ts) that synchronously returns `{ backend: typeof navigator !== "undefined" && (navigator as any).gpu ? "WebGPU (no Cornerstone support)" : "WebGPU not available", note: typeof navigator !== "undefined" && (navigator as any).gpu ? "Cornerstone3D 4.15 has no WebGPU backend" : "WebGPU not available" }` — no rendering, no viewport, no resources allocated (VR-5 trivially satisfied per research R3)
- [X] T007 [US2] Re-export `cornerstoneBenchProbeWebGPU` from [src/dicom/index.ts](src/dicom/index.ts)
- [X] T008 [US2] In [src/App.tsx](src/App.tsx), import `cornerstoneBenchProbeWebGPU` from `./dicom`
- [X] T009 [US2] Refactor [src/App.tsx](src/App.tsx) `runBenchmark` to build the rows array in the **locked C-2 order** by name-keyed assembly: time each engine into a local map (`babylonRow`, `webgpuRow`, `cpuRow`, `cornerstoneWebGLRow`, `cornerstoneWebGPURow`), then `setBench([babylonRow, cornerstoneWebGLRow, webgpuRow, cornerstoneWebGPURow, cpuRow])` — guaranteeing VR-1 (one of each kind) and VR-2 (correct order) regardless of which probes/engines succeeded. **Must preserve** the existing warmup-discard + `BENCH_SAMPLES` median sampling pattern for every timed row (FR-010); only the placeholder Cornerstone-WebGPU row is exempt from timing.
- [X] T010 [US2] In [src/App.tsx](src/App.tsx) `runBenchmark`, populate `cornerstoneWebGPURow` from `cornerstoneBenchProbeWebGPU()` as `{ kind: "cornerstone-webgpu", name: "Cornerstone (WebGPU)", ms: null, note, backend }` — the row is **unconditionally** present with `ms: null` (FR-007, FR-007a, FR-012, C-9)

**Checkpoint**: US2 complete — the benchmark table is locked to the
five-row, backend-grouped contract from C-1 / C-2 on every browser.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: User-facing hint text, README documentation, and reviewer
validation.

- [X] T011 Update the explanatory `<p className="hint">` paragraph in [src/components/BenchmarkPanel.tsx](src/components/BenchmarkPanel.tsx) to cover (a) Babylon/CPU = upload + compute + readback, (b) **both** Cornerstone rows = set VOI → GPU render → IMAGE_RENDERED (no readback), windowing only, and (c) the Cornerstone-WebGPU row is `n/a` because Cornerstone3D's pinned version has no WebGPU backend, kept as a permanent placeholder for environment documentation (C-10). **Content depends on US2** (T010) because the hint references the Cornerstone-WebGPU row — schedule after US2, do not parallelize across the US1/US2 boundary.
- [X] T012 [P] Update [README.md](README.md) to document the new 5-row benchmark layout (backend-grouped, CPU last) and the rationale for the always-`n/a` Cornerstone-WebGPU placeholder, so a first-time reviewer is not confused by the missing number (quickstart.md "Pass criteria")
- [X] T013 Run `npm run build` from the repo root and confirm it succeeds (tsc --noEmit + vite build with no type errors) — covers VR-3 / C-5 statically because the narrowed `kind` union from T001 forces the comparable-check to remain exclusive
- [ ] T014 Walk [quickstart.md](specs/001-cornerstone-engines/quickstart.md) end-to-end in a WebGPU-capable browser (Chrome 113+) — verify all 7 steps in "Verification on a WebGPU-capable browser" plus the 4 cross-environment FR-007a checks. **This is the runtime acceptance gate** for the feature (per constitution Development Workflow "browser validation gap")

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: empty
- **Foundational (Phase 2)**: no upstream dependency — `T001` is the first
  thing to do
- **User Story 1 (Phase 3)**: depends on T001
- **User Story 2 (Phase 4)**: depends on T001 **and** on T002 (US1's helper
  renames) because T004 / T008 share the same import block in App.tsx;
  serializing US2 after US1 avoids merge conflicts inside that block
- **Polish (Phase 5)**: T011 depends on US2 (T010) because its hint copy references the Cornerstone-WebGPU row; T012 ([README.md](README.md)) depends only on T001 and can run any time; T013 / T014 depend on all preceding tasks

### User Story Dependencies

- **US1 (P1)**: Foundational T001 only. Deliverable on its own as MVP-minus
  (the WebGL row is correctly labeled and slotted; the WebGPU placeholder
  is not yet there and row order is not yet locked).
- **US2 (P2)**: Foundational T001 + US1 helper renames (T002). US2 lands
  both the placeholder row **and** the final C-2 row ordering (T009),
  because the order is most cleanly applied at the same time both
  Cornerstone rows exist.

### Within Each User Story

- US1: T002 (rename in `cornerstoneSetup.ts`) → T003 (update `index.ts`
  re-exports) → T004 (update `App.tsx` imports) → T005 (update row
  construction). Strict sequence — each task depends on the rename
  introduced by the previous one.
- US2: T006 (add probe in `cornerstoneSetup.ts`) → T007 (re-export) → T008
  (import in `App.tsx`) → T009 (refactor `runBenchmark` to keyed assembly +
  locked order) → T010 (wire the probe into the new row slot). Strict
  sequence.

### Parallel Opportunities

- **Within Phase 5**: T012 ([README.md](README.md)) is the only `[P]` task in Polish; it has no ordering dependency on T011 ([src/components/BenchmarkPanel.tsx](src/components/BenchmarkPanel.tsx)) and can run any time after T001. T011 is **not** parallelizable across the US1/US2 boundary because its content describes the Cornerstone-WebGPU row introduced in US2.
- **Across stories**: US1 and US2 share `App.tsx` (T005 vs T008–T010) and
  `cornerstoneSetup.ts` (T002 vs T006) and `dicom/index.ts` (T003 vs T007).
  Running them in parallel by different people would conflict in every
  shared file. **Recommendation**: ship US1 → review → ship US2, sequentially.

---

## Parallel Example: Phase 5 Polish

After all of Phase 2–Phase 4 (US2) is done, T011 can begin (it depends on
the Cornerstone-WebGPU row from T010). T012 ([README.md](README.md)) is
file-independent of T011 and may run earlier or in parallel:

```text
T011      Update hint text in src/components/BenchmarkPanel.tsx  (after T010)
T012 [P]  Update README.md with 5-row layout + WebGPU placeholder rationale
```

Then T013 + T014 run sequentially as the validation gate.

---

## Implementation Strategy

### MVP (US1 only)

T001 → T002 → T003 → T004 → T005 ships a benchmark where the Cornerstone
row is honestly labeled "Cornerstone (WebGL)" with its WebGL version in
the Backend column. This is already valuable on its own — it resolves the
"which Cornerstone backend?" caveat that motivated the spike — even
without the WebGPU placeholder row. Reviewers can compare
`Babylon (WebGL, worker)` vs `Cornerstone (WebGL)` apples-to-apples.

### Full feature (US1 + US2 + Polish)

Sequentially: US1 → US2 → Polish. The full delivery additionally locks the
5-row backend-grouped layout (FR-007a, SC-001) so the table is
environment-independent and the WebGPU comparison story is also told
(`Babylon (WebGPU)` vs `Cornerstone (WebGPU)` — with the latter
permanently `n/a` and the reason note explaining why, surfacing the
upstream limitation per FR-012).

### Risk surface

The whole change-set is 4 source files + 1 doc. The headline risk —
"Cornerstone3D 4.15 has no WebGPU backend" — is **not a risk to mitigate
in code**; the design accommodates it explicitly (permanent placeholder
row). The only runtime risk left is browser-level WebGPU initialization
for the Babylon-WebGPU row, which is already in production today and
unchanged by this feature.

---

## Task summary

- **Total tasks**: 14
- **Setup (Phase 1)**: 0
- **Foundational (Phase 2)**: 1 (T001)
- **User Story 1 (Phase 3)**: 4 (T002–T005)
- **User Story 2 (Phase 4)**: 5 (T006–T010)
- **Polish (Phase 5)**: 4 (T011–T014)
- **Parallel-marked [P]**: 1 (T012)
- **MVP scope**: T001–T005 (Phase 2 + Phase 3 = User Story 1 only)
