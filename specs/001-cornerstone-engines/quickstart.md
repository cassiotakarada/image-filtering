# Quickstart — Verify Cornerstone WebGL + WebGPU Benchmark Rows

**Feature**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Contract**: [contracts/benchmark-rows.md](./contracts/benchmark-rows.md)
**Date**: 2026-06-26

Purpose: a reviewer-runnable checklist that verifies this feature
end-to-end against the spec and the UI contract. There is no automated
test runner in this spike (per constitution Development Workflow), so
this checklist is the validation surface.

---

## Setup

```bash
git checkout 001-cornerstone-engines
npm install
npm run build           # tsc --noEmit + vite build, MUST succeed
npm run dev             # http://localhost:5173
```

Open the dev URL in **two browsers** if possible:

1. A WebGPU-capable browser (Chrome 113+, Edge 113+, recent Firefox Nightly
   with `dom.webgpu.enabled`). Recommended primary.
2. A WebGL-only browser (or Chrome with `chrome://flags/#enable-unsafe-webgpu`
   disabled, or Safari < 18 without WebGPU). Recommended secondary.

---

## Verification on a WebGPU-capable browser

1. Wait for the status bar to show `Ready`.
2. Click **Run benchmark**.
3. Verify the benchmark table appears with **exactly five rows** in this
   order, top to bottom:
   1. `Babylon (WebGL, worker)` — backend tag like `WebGL2`, ms value,
      "vs CPU" shows a speedup like `12.3×`
   2. `Cornerstone (WebGL) · windowing only` — backend tag `WebGL2`
      (or `WebGL1`), ms value, "vs CPU" shows `—`
   3. `Babylon (WebGPU, main thread)` — backend tag `WebGPU`, ms value,
      "vs CPU" shows a speedup
   4. `Cornerstone (WebGPU) · Cornerstone3D 4.15 has no WebGPU backend` —
      backend tag `WebGPU (no Cornerstone support)`, ms shows `n/a`,
      "vs CPU" shows `—`
   5. `CPU (JavaScript)` — backend tag like `JavaScript`, ms value,
      "vs CPU" shows `baseline`
4. Verify the explanatory hint below the table mentions both Cornerstone
   rows and explicitly notes that Cornerstone-WebGPU is a placeholder.
5. Adjust a filter slider (e.g., sharpen → 5) and click **Run benchmark**
   again. The same five rows MUST reappear in the same order, with
   updated `ms` values for the four "real" rows; the WebGPU-Cornerstone
   row MUST stay `n/a` with the same note.
6. Change phantom size to **2048²** via the Controls. Wait for "Ready".
   Click **Run benchmark**. Verify the five rows still appear in order
   and that the `ms` values increased proportionally for the WebGL rows
   (sanity that the bench is timing the new source per FR-009).
7. Click **Run benchmark** ten times in a row at 2048². Open DevTools →
   Memory → take a heap snapshot before run 1 and after run 10. Memory
   should be flat-ish (no unbounded growth — SC-005). DOM node count
   (DevTools → Elements panel root depth) should be unchanged.

## Verification on a WebGL-only / no-WebGPU browser

1. Wait for `Ready`.
2. Click **Run benchmark**.
3. Verify the table contains **exactly five rows in the same order** as
   the WebGPU-capable run. The only differences are:
   - Row 3 (`Babylon (WebGPU, main thread)`) shows `n/a` with backend
     tag like `WebGPU (unavailable)` and a note explaining the failure.
   - Row 4 (`Cornerstone (WebGPU)`) shows `n/a` with backend tag
     `WebGPU not available` and the note describing why
     (browser-level lack, not the Cornerstone-level lack).
4. The other three rows (Babylon-WebGL, Cornerstone-WebGL, CPU) MUST
   still produce real `ms` values.
5. The hint paragraph below the table is unchanged.

## Cross-environment verification (the constant-row-set check, FR-007a)

Open both browsers side by side. Confirm:

- Both tables have **exactly the same row labels in the same order**.
- The only differences are inside individual rows' `ms` / `backend` /
  `note` cells. **No row appears in one table but not the other.**

---

## Failure-mode spot checks

| What to break | Expected behavior |
|---|---|
| Disable WebGPU in browser flags after page load → re-run bench | Babylon-WebGPU + Cornerstone-WebGPU rows show `n/a` with reason; other rows unaffected. |
| Throw an exception inside `cornerstoneBenchRender` (temporarily, for testing) | The `cornerstone-webgl` row shows `n/a` with the error message; all other rows still produce times. |
| Run the bench before clicking "Show original" or loading a phantom | Cornerstone rows should still bench against whatever source is currently active; if no source has loaded yet (impossible in normal flow, but worth flagging), the row shows `n/a`. |
| Resize the phantom while a benchmark is in flight | The `busy` flag in `App.tsx` already disables the controls; verify the in-flight run still completes against the previous source and the next run picks up the new one. |

---

## Pass criteria

- All steps above complete without surprises.
- No type-check or build errors (`npm run build` succeeded at setup).
- README has been updated to mention the 5-row table and the
  Cornerstone-WebGPU placeholder rationale (so a first-time reviewer
  isn't confused by the always-`n/a` row).

If all pass, the feature satisfies spec [FR-001 through FR-012] and
success criteria [SC-001 through SC-005].
