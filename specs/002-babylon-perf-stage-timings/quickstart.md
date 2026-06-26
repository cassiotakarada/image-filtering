# Quickstart — Babylon Per-Stage Timing Breakdown

**Feature**: `002-babylon-perf-stage-timings`
**Audience**: Reviewer running the app locally for the first time on this branch.

This is the **runtime gate** for the feature, because the author cannot run
the app in a browser (constitution: "Browser validation gap"). Follow these
steps in order; record any deviation as a defect.

## 0. Prerequisites

- Node 20+, modern Chromium (Chrome 113+ / Edge 113+) for the WebGPU row;
  any WebGL2 browser is fine for the WebGL row.
- Clean checkout of branch `002-babylon-perf-stage-timings`.

## 1. Build + serve

```bash
npm install
npm run build         # MUST exit 0 (tsc --noEmit + vite build)
npm run dev           # Vite dev server on http://localhost:5173
```

Open the dev URL in a WebGPU-capable browser (or pass `?disable-webgpu` if
your browser supports the flag, to verify the unavailable-row path).

## 2. Land on the default phantom

The app boots into the 512×512 synthetic phantom by default. Wait until the
status line reports `Ready`.

## 3. Run the benchmark

Click the **Run benchmark** button (in the Controls panel).

**Expected (happy path, WebGPU available):**

- The benchmark panel renders **five rows** in the locked order from spec
  001 contract C-2:
  1. `Babylon (WebGL, worker)` — WebGL2 — `ms / run` ≈ ~120 ms (machine-dependent)
  2. `Cornerstone (WebGL)` — WebGL2 — `ms / run` ≈ single-digit ms
  3. `Babylon (WebGPU, main thread)` — WebGPU — `ms / run` ≈ ~280 ms (the row this feature is investigating)
  4. `Cornerstone (WebGPU)` — `n/a` with note `Cornerstone3D 4.15 has no WebGPU backend`
  5. `CPU (main thread)` — JS — `ms / run` ≈ ~500 ms
- **Under rows 1 and 3** (the two Babylon rows), a secondary line shows
  five sub-values in this fixed order:
  `compile · upload · compute · readback · round-trip`, two-decimal ms.
- Under rows 2, 4, and 5, **no sub-line is rendered**.

## 4. Verify row order (contract C-4)

Confirm the five top-level rows match spec 001 contract C-2 exactly — same
labels, same backend tags, same `n/a` + note on the Cornerstone (WebGPU)
row. This feature MUST NOT have reordered or relabeled them.

## 5. Verify stage reconciliation (contract C-3)

For each of the two Babylon rows:

1. Read the four engine-internal stages: `compile + upload + compute + readback`.
2. Compute the sum.
3. Compare against the row's `ms / run`.
4. Confirm the difference is within `max(1.0 ms, 5 % of ms / run)`.

Example (numbers will differ on your machine):

```text
Babylon (WebGL, worker):   ms = 122.00; stages sum to 116.78; diff = 5.22 ms
                           5.22 > max(1, 6.10) ? NO  → OK (within 5 % tolerance)

Babylon (WebGPU, main):    ms = 285.70; stages sum to 285.48; diff = 0.22 ms
                           0.22 > max(1, 14.29) ? NO  → OK
```

If any Babylon row's gap exceeds the tolerance, file a defect — a chunk of
time is unaccounted for and the breakdown is misleading.

## 6. Form a dominant-stage conclusion (spec SC-001 + SC-003)

Within 30 seconds of looking at the panel:

1. For the **Babylon (WebGPU, main thread)** row, identify the largest
   stage value and write it down. *Predicted:* `readback` dominates by a
   wide margin.
2. For the **Babylon (WebGL, worker)** row, identify the largest stage
   value. *Predicted:* either `readback` or `round-trip` dominates; the
   ranking is what answers "where is the worker engine spending its time".
3. Note the `round-trip` stage on the Babylon (WebGPU) row — it MUST be
   `0.00` (that engine runs on the main thread; spec FR-007).

Record a one-line conclusion such as:
`"Babylon-WebGPU at 285 ms is dominated by readback (≈283 ms of 286 ms total)."`
This conclusion *is* spec SC-003's deliverable. Capture it in the PR description
or in README per the implementation plan.

## 7. Verify the unavailable-row path

In a browser without WebGPU (or with WebGPU disabled), repeat step 3.

**Expected:**

- Row 3 (`Babylon (WebGPU, main thread)`) shows `ms / run = n/a` and **no
  sub-line** (or `—` placeholders, depending on UI choice). The five
  top-level rows are still all present in the locked order.
- All other rows behave normally.

## 8. Verify the `ms / run` numbers are stable (spec SC-004)

Compare the `ms / run` of Babylon-WebGL, Babylon-WebGPU, and CPU on this
branch against the same values from `bruno` (which is where spec 001 was
merged from). They MUST agree to within normal inter-run variance — the
instrumentation MUST NOT have introduced a visible regression.

Easy way:

```bash
# On a quiet machine, in two browser tabs:
# Tab A: dev server from `bruno`
# Tab B: dev server from `002-babylon-perf-stage-timings`
# Run the benchmark on the default 512² phantom in each, several times.
# Compare medians.
```

If the new branch's `ms / run` is consistently > a few ms higher, file a
defect — the instrumentation is too expensive.

## 9. Verify the hint paragraph (contract C-5)

Scroll to the bottom of the benchmark panel. Confirm the hint paragraph:

- Names and explains all five stages (compile, upload, compute, readback,
  round-trip).
- Explains why CPU and Cornerstone rows have no breakdown.
- Still carries the spec 001 disclaimer about the Cornerstone (WebGPU)
  placeholder and the "windowing only" caveat.

## 10. Sign off

If steps 3–9 all pass, the feature ships. The runtime evidence is captured
by:

- A screenshot of the benchmark panel showing both Babylon rows with their
  sub-cells populated; and
- The one-line dominant-stage conclusion from step 6, written into the PR
  description or README.

If any step fails, file a defect against this branch and do not merge.
