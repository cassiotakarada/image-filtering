# UI Contract — Benchmark Table Row Set

**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Surface**: [src/components/BenchmarkPanel.tsx](../../../src/components/BenchmarkPanel.tsx) rendered output

This document is the **user-facing contract** for the benchmark table that
appears after clicking **Run benchmark**. It exists so a reviewer can verify
the implementation against a single normative source (in addition to spec FRs)
and so a future port into CSOI-Web has an unambiguous target.

The contract is observable from the rendered DOM — no automated test runs it,
but the [quickstart.md](../quickstart.md) walks a human through verifying each
clause.

---

## C-1. Row set

The benchmark table MUST contain exactly **five rows**, with `kind`
discriminator and label as follows:

| Order | `kind` | Visible label |
|---|---|---|
| 1 | `babylon` | `Babylon (WebGL, worker)` |
| 2 | `cornerstone-webgl` | `Cornerstone (WebGL)` |
| 3 | `webgpu` | `Babylon (WebGPU, main thread)` |
| 4 | `cornerstone-webgpu` | `Cornerstone (WebGPU)` |
| 5 | `cpu` | `CPU (JavaScript)` |

(Engine `name` strings come from the engine implementations and may be
revised cosmetically; the **order** and the **`kind` values** are the
binding contract.)

## C-2. Order

The order in C-1 is the contract. It is **backend-grouped, CPU last**, so
that WebGL-vs-WebGL and WebGPU-vs-WebGPU comparisons are visually adjacent.

## C-3. Constant set

The row set MUST NOT change across environments. On any browser, all five
rows are emitted; the only thing that varies between environments is the
per-row `ms` / `note` / `backend` values.

## C-4. Columns

The table MUST expose four columns in this order: **Engine**, **Backend**,
**ms / run**, **vs CPU**. (Existing layout; preserved.)

## C-5. "vs CPU" column rules

- For `kind === "cpu"`: display `baseline`.
- For `kind === "babylon"` or `kind === "webgpu"`: display speedup ratio
  `(cpu.ms / row.ms).toFixed(1) + "×"` when both are non-null; else `—`.
- For `kind === "cornerstone-webgl"` or `kind === "cornerstone-webgpu"`:
  always display `—`. **Never** compute a Cornerstone vs CPU ratio —
  the rows measure different work (Cornerstone is windowing-only).

## C-6. "Backend" column rules

The backend tag in the **Backend** column is governed by
[data-model.md](../data-model.md) E1 "Backend tag values" table. The
exhaustive matrix is reproduced there.

## C-7. `ms` column rules

- When `ms !== null`: display `ms.toFixed(2)`.
- When `ms === null`: display `n/a`.

## C-8. `note` column rules

The note is appended to the engine name, formatted as
`{name} · {note}` in a `.note` span. A note MUST be present whenever
`ms === null`. For both Cornerstone rows the note MUST also be present
in the success case (`"windowing only"` for WebGL; the WebGPU row is
always `n/a` so its note is always its failure reason — see C-9).

## C-9. Cornerstone-WebGPU row's permanent state

In the pinned Cornerstone3D version (`^4.15.21`), the
`cornerstone-webgpu` row MUST always have `ms: null` and one of these
notes:

- `"Cornerstone3D 4.15 has no WebGPU backend"` when the browser supports
  WebGPU (`navigator.gpu` is defined) — surfaces the upstream limitation.
- `"WebGPU not available"` when the browser itself lacks WebGPU.

These two strings are part of the contract because the spec
(`FR-012`) requires the row to "surface that fact" rather than be silent.

## C-10. Hint text

The explanatory paragraph below the table MUST be updated from today's
single-Cornerstone phrasing to acknowledge two Cornerstone rows and to
state that the WebGPU one is currently a placeholder. Exact text is left
to implementation but MUST cover:

- Babylon/CPU time = param upload + compute + GPU→CPU readback.
- Both Cornerstone rows time = set VOI → GPU render → IMAGE_RENDERED
  event (no readback); windowing only.
- The Cornerstone-WebGPU row is `n/a` because Cornerstone3D's pinned
  version doesn't ship a WebGPU backend; the row remains in the table
  for environment-documentation purposes and so a future Cornerstone
  release can populate it.

## C-11. Stability across runs

Re-running **Run benchmark** N times MUST produce the same five rows in
the same order. Only the `ms` / `note` values may change. No row may
appear or disappear between runs based on previous-run outcomes.

---

## Out of contract (explicitly)

- The **values** of `ms` — performance numbers are evidence, not a
  contract. They're expected to vary by machine, browser, phantom size,
  and filter settings.
- The Cornerstone-WebGPU row's behavior **if Cornerstone3D ships a
  WebGPU backend in a future version** — at that point this contract
  must be revised (the row would gain a real `ms` value).
- The exact wording of the explanatory hint paragraph (C-10 requires
  coverage, not specific copy).
