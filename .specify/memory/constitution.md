<!--
SYNC IMPACT REPORT
==================
Version change: 1.2.0 → 1.3.0
Rationale: MINOR bump — relaxes the integration-branch rule to permit
direct commits/pushes to `bruno`. The protected-branch principle
(main/master/develop) is unchanged and still NON-NEGOTIABLE. Bump is
MINOR (not PATCH) because the change materially expands what agents are
allowed to do without violating a non-negotiable; it is not a typo fix.

Modified principles:
  (none — Core Principles I–V unchanged)

Modified sections:
  - Development Workflow → "Protected branches & integration target":
    `bruno` is now writable directly (commit + push). Feature branches
    are still branched from `bruno`, and feature-branch work still
    reaches `bruno` via PRs targeting `bruno`. main/master/develop
    remain protected with no direct commits and no PR target.

Added sections:
  (none)

Removed sections:
  (none)

Templates requiring updates:
  - .specify/templates/plan-template.md  ✅ compatible
  - .specify/templates/spec-template.md  ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
  - .specify/templates/checklist-template.md ✅ compatible
  - .github/copilot-instructions.md      ✅ compatible
  - .specify/extensions/git/git-config.yml ✅ compatible — auto_commit
    hooks still gated by user confirmation; they may now fire on `bruno`

Follow-up TODOs:
  - None.

---
Previous version history:
- 1.2.0 (2026-06-26): Named `bruno` as the integration branch and the
  only legal PR target; required PR-only merges into `bruno`. Fixed a
  `MU1T` typo in Governance.
- 1.1.0 (2026-06-26): Added NON-NEGOTIABLE Protected Branches rule (no
  direct commits to main/master/develop; feature branches + PR only).
- 1.0.0 (2026-06-26): Initial concrete ratification. MAJOR bump from
  unfilled template. Established Core Principles I–V (Engine Parity,
  Diagnostic Fidelity, Display-Seam Isolation, Off-Main-Thread + Single
  Readback, Synthetic-Data-Only), Spike Scope & Evidence Standards,
  Development Workflow, and Governance.
-->

# Babylon Filter Spike Constitution

This repository is a **throwaway proof-of-concept** evaluating whether running
DICOM image filters on the GPU (Babylon.js) behind a Cornerstone3D display
seam is meaningfully faster than the current CPU/main-thread path in CSOI-Web.
Its only deliverable is **credible evidence** to guide a port decision. The
principles below exist to keep that evidence trustworthy.

## Core Principles

### I. Engine Parity (NON-NEGOTIABLE)

Every implementation of the `FilterEngine` interface (`src/engine/types.ts`)
MUST run the same filter graph with the same math on the same `FilterParams`,
operating on the same `ImageBuffer` input and emitting the same `FilterResult`
shape. Backend-specific code (WebGL2 vs WebGPU vs CPU) MUST be confined behind
that interface.

**Rationale:** Benchmarks are only meaningful apples-to-apples. If the Babylon
engine "wins" by doing less work than the CPU baseline, the spike has no
evidentiary value and the port decision is built on sand. Parity is what makes
the speedup number worth porting for.

### II. Diagnostic Fidelity

Filtering MUST happen at native bit depth using `Float32` of the stored pixel
values (which may be signed/HU for CT) over the full native range. The output
MUST be a 12-bit linear image (`OUTPUT_MAX = 4095`) produced by the filter's
own windowing, not an 8-bit RGBA canvas readback. 8-bit intermediate paths
are forbidden in the filter pipeline.

**Rationale:** The current Fabric.js path in CSOI-Web filters 8-bit canvas data
and is both slower and diagnostically lossy. Reproducing that loss would
invalidate the spike: a "faster" engine that throws away the same precision
the legacy path does cannot justify a port for a diagnostic viewer.

### III. Display-Seam Isolation

Filter execution MUST be decoupled from display. Engines MUST NOT share a GPU
context with Cornerstone, MUST NOT depend on Cornerstone types beyond the
`filtered:` loader/metadata seam (`src/dicom/cornerstoneSetup.ts`), and MUST
hand off results as a plain typed-array `FilterResult`. The `src/engine/`
folder MUST remain framework-agnostic and portable into CSOI-Web verbatim.

**Rationale:** Shared GPU contexts are the historical reason "GPU integrations"
turn into rewrites instead of drop-ins. The whole port-the-win story depends
on `src/engine/` being liftable; any coupling to Cornerstone or React inside
that folder defeats the spike's purpose.

### IV. Off-Main-Thread Execution with Single Readback

GPU engines MUST run on a Web Worker driving an `OffscreenCanvas`. The filter
graph MUST execute as a single GPU pass (or chained passes via render targets)
with exactly **one** GPU→CPU readback per `run()` call, taken at the end. Per-
pass readback during the graph is forbidden. The CPU engine MUST run identical
math on the main thread (for parity and to expose the gap honestly).

**Rationale:** Per-pass readback is the standard cause of "GPU felt slow"
results that mislead architecture decisions. Worker + OffscreenCanvas is also
how slider drags stop blocking React/Cornerstone — the "lagging" fix that is
part of the win being measured. Violating either condition produces numbers
that won't survive review.

### V. Synthetic Data Only (NON-NEGOTIABLE)

No PHI/PII MUST ever enter this repository, in source, fixtures, screenshots,
logs, commit history, or issue trackers. All test images MUST come from the
procedurally generated phantom (`src/dicom/syntheticDicom.ts`). Real patient
DICOMs, anonymized or otherwise, MUST NOT be added.

**Rationale:** This is an unregulated spike outside the controls of the
CSOI-Web codebase. Introducing patient data — even "de-identified" — would
turn a throwaway prototype into a compliance incident and contaminate the
artifact that the port decision is based on.

## Spike Scope & Evidence Standards

The repository is bounded by these standards:

- **Scope:** The kernel filters listed in `FilterParams` (windowing, CLAHE,
  denoise, sharpen, edge, gamma, invert, LUT, segmentation). ML/learned
  filters (denoise, super-resolution) are explicitly out of scope and belong
  to a separate ONNX-runtime engine track.
- **Benchmarks are the deliverable:** Every engine MUST report `elapsedMs` per
  `run()` covering parameter upload + compute + readback (excluding the
  one-time `setImage()` upload). The benchmark panel MUST report median ms
  per engine and the speedup vs the CPU baseline. Single-run timings MUST NOT
  be presented as headline numbers.
- **Honesty about limits:** Known runtime risks (e.g., the
  `EXT_color_buffer_float` dependency for float render targets, the
  `proc.isReady()`/`proc.render()` timing in the Babylon worker, the
  hand-rolled Explicit-VR-LE DICOM encoder) MUST stay documented in `README.md`
  so reviewers know where the spike is unvalidated.
- **Throwaway by design:** Code quality is sufficient if (a) the principles
  above hold and (b) `src/engine/` is portable. Production-grade test
  coverage, error taxonomy, and observability are out of scope and SHOULD NOT
  be added speculatively.
- **Porting target:** Only `src/engine/` is intended to port into CSOI-Web.
  Cornerstone wiring, the synthetic-DICOM generator, the controls panel, and
  React glue are spike-only and MUST NOT accrete coupling that pretends
  otherwise.

## Development Workflow

- **Protected branches & integration target (NON-NEGOTIABLE):**
  - `main`, `master`, and `develop` are **protected**. No commits, merges,
    or pushes MUST land on them directly, and PRs in this repository MUST
    NOT target them. Agents and tooling MUST refuse `git commit`,
    `git merge`, `git push`, or PR-creation operations against these
    branches without explicit, per-action user override.
  - `bruno` is the **integration branch** for this repository and the
    only legal PR target. Direct commits and pushes to `bruno` ARE
    permitted (no PR required for one-off work on `bruno` itself).
    Spec-kit auto-commit hooks (`speckit.git.commit`) MAY fire on
    `bruno` subject to the existing user-confirmation gate.
  - Feature work MUST branch from `bruno` (e.g., `NNN-short-name` from
    `/speckit.specify`, or any short-lived branch) and reach `bruno`
    only via a pull request **targeting `bruno`** — never
    main/master/develop. Once a feature branch exists, work for that
    feature MUST stay on it; pushing that work directly to `bruno`
    bypasses the review checkpoint and is not permitted.
  - Spec-kit auto-commit hooks MUST NOT be accepted while HEAD is on a
    protected branch (`main`/`master`/`develop`); switch to `bruno` or a
    feature branch first.
- **Type safety is the gate:** `npm run build` (runs `tsc --noEmit` + `vite
  build`) MUST pass on every change. `npm run type-check` MUST pass before any
  commit that touches `src/`. There is no automated test runner; parity is
  verified by visual diff against the CPU engine and by benchmark consistency
  across re-runs.
- **Single-contributor amendment flow:** Architectural changes (new engine
  backend, change to the `FilterEngine` interface, change to filter math)
  MUST be reflected in `README.md` in the same change so the spike's claims
  stay accurate.
- **Spec-driven changes:** Non-trivial features SHOULD go through the
  `.specify/` workflow (`/speckit.specify` → `/speckit.plan` →
  `/speckit.tasks` → `/speckit.implement`). The Constitution Check gate in
  `plan-template.md` MUST cite the principles above when evaluating a plan.
- **Browser validation gap:** The author cannot run the app in a browser.
  Reviewers running `npm run dev` for the first time are the de facto runtime
  test stage; any failures they hit MUST be triaged against the risk list in
  `README.md` before changing the architecture.

## Governance

This constitution supersedes ad-hoc conventions for **this repository only**.
It does not bind CSOI-Web; production rules live in that codebase. Within this
repo:

- All changes MUST verify the five Core Principles before merge. A change that
  violates a principle MUST either revise the change or amend the constitution
  in the same PR with a justified version bump.
- Versioning follows semantic versioning:
  - **MAJOR:** Removing or redefining a principle, or relaxing a NON-NEGOTIABLE.
  - **MINOR:** Adding a new principle or section, or materially expanding the
    rules of an existing one.
  - **PATCH:** Clarifications, typo fixes, non-semantic refinements.
- Amendments MUST update `LAST_AMENDED_DATE`, bump `CONSTITUTION_VERSION`, and
  emit a Sync Impact Report (as the HTML comment at the top of this file)
  covering modified principles, added/removed sections, and downstream
  template updates.
- `RATIFICATION_DATE` is the date this constitution first took concrete
  (non-template) form and is not changed by amendments.
- Runtime development guidance for AI agents lives in
  `.github/copilot-instructions.md` (which defers to the active plan).

**Version**: 1.3.0 | **Ratified**: 2026-06-26 | **Last Amended**: 2026-06-26
