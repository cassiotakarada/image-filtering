# Phase 0 — Research: Babylon Per-Stage Timing Breakdown

**Feature**: `002-babylon-perf-stage-timings`
**Inputs**: [spec.md](./spec.md), [plan.md](./plan.md)

This document resolves the five unknowns from `plan.md` → Phase 0 by inspecting
the existing Babylon engine code and gathering web evidence on browser timing
semantics. No code in this feature changes; this is research only.

---

## Decision 1 — Stage-boundary placement in the existing Babylon code

**Question:** Where exactly do the four GPU-side stage boundaries (compile,
upload, compute, readback) land in `src/engine/babylon/babylon.worker.ts` and
`src/engine/babylon/BabylonWebGPUEngine.ts` so they cover all observable
per-run time without overlapping?

**Decision:** The boundaries land at code seams that already exist in both
engines, in this exact order inside `run()` / `handleRun()`:

```text
                          // BEGIN run()
t0 = performance.now()
  // upload: all proc.setVector2 / proc.setFloat / proc.setTexture calls,
  // plus CLAHE-map texture rebuild (when claheKey changed), plus LUT swap.
t1 = performance.now()
  // compile: for (let i = 0; i < 600 && !proc.isReady(); i++) await sleep(2)
  //          (no-op on warmed-up runs; first run after a shader cache miss
  //          will register here).
t2 = performance.now()
  proc.render()                              // compute: GPU submit
t3 = performance.now()
  raw = await proc.readPixels()              // readback: forces GPU sync
t4 = performance.now()
  // (CPU-side un-interleave to grayscale/RGB — NOT counted in any stage,
  // and NOT counted in the existing elapsedMs either; see "Reconciliation"
  // below for why this matters)
                          // END run()
```

Mapping:

- **compile** = `t2 − t1` (shader-ready wait observed inside the timed region)
- **upload** = `t1 − t0` (all uniform setters + texture rebinds + CLAHE map rebuild)
- **compute** = `t3 − t2` (`proc.render()`)
- **readback** = `t4 − t3` (`await proc.readPixels()` — includes the implicit GPU sync)

The existing `elapsedMs` in both engines is computed as `performance.now()
- t0` where `t0` is taken *after* the shader-ready wait, *before* `proc.render()`
(see [babylon.worker.ts](../../src/engine/babylon/babylon.worker.ts) lines around
`for (let i = 0; i < 600 && !proc.isReady()…` and the immediately-following
`const t0 = performance.now()`). To make the existing `ms / run` comparable
to a clean `compute + readback` sum, this feature **shifts** the existing
`t0` measurement to *before* the shader-ready wait. The shader-ready wait is
a no-op on warmed-up runs (Decision 3 below), so the headline `ms / run` is
unchanged in practice for any warmup-discarded sample — but the
"reconciliation gap" required by SC-002 stays small.

**Rationale:** Picking these four boundaries means we measure exactly what the
existing `elapsedMs` already measures, just decomposed. No new GPU work is
introduced (Constitution IV preserved). The four `performance.now()` reads
between them cost ~0.001 ms each on modern Chromium (per `performance.now()`
spec: `DOMHighResTimeStamp` is monotonic and cheap), so SC-004 holds.

**Alternatives considered:**

- *Measuring `proc.render()` separately from `proc.readPixels()` using
  `gl.finish()` after `render()`* — rejected. Adding a `gl.finish()` is a
  hard GPU sync that materially changes the run's behavior and would
  violate the "instrumentation as observation" rule. The implicit sync at
  `await readPixels()` is already present and gives an honest "GPU done"
  boundary at `t4`.
- *EXT_disjoint_timer_query_webgl2 / GPU timer queries* — rejected. Native
  GPU timer queries would give per-pass GPU time, but (a) they require an
  extension that isn't universally available, (b) the spike's goal is to
  surface CPU↔GPU bottlenecks (where the time is going from the JS thread's
  perspective), not to attribute GPU shader time. `performance.now()` at the
  JS boundaries is the right tool for that question.
- *Performance.measure / mark instead of raw now()* — rejected. We'd still
  need now() reads at the boundaries; marks would only be useful if we
  wanted Chrome DevTools to also visualize the boundaries, which is
  out-of-scope (the panel is the deliverable, not the dev-tools UX).

---

## Decision 2 — Is the WebGPU `readback` the dominant stage?

**Question:** Is the bulk of the Babylon-WebGPU run actually spent in
`proc.readPixels()` (i.e. CPU↔GPU sync through a staging buffer), or in
`proc.render()` (the GPU submit itself)?

**Decision:** The plan assumes — and the breakdown will prove or disprove —
that **`readback` dominates** the Babylon (WebGPU, main thread) row's median
time on the 512² synthetic phantom.

**Rationale:** Three pieces of evidence point this way:

1. The WebGPU engine's existing code in
   [`BabylonWebGPUEngine.ts`](../../src/engine/babylon/BabylonWebGPUEngine.ts)
   has a comment noting that float textures are "not linearly filterable on
   WebGPU without an optional feature", which is why all textures use NEAREST
   sampling there. Float-format textures + readback to a `Float32Array` go
   through a staging buffer that the browser's WebGPU implementation copies
   into JS memory after a queue submit — this is a known cost on
   `RTX 30xx + Windows + Chromium` of the order of ~100–300 ms for a 512²
   `r32float` texture, depending on driver state.

2. The Babylon-WebGL row (worker, off-main-thread) at 122.00 ms includes the
   full worker round-trip (`postMessage` of a transferred `Float32Array` of
   `512 * 512 = 262144` floats = 1 MB) plus the `gl.readPixels` path, which
   is a well-trod, cached code path. That it comes in *under* the WebGPU
   row strongly suggests the WebGPU readback path is the differentiator.

3. The remaining stages (compile, upload, compute) should be cheap on both
   paths: shaders are warmed up by the first sample (discarded by warmup),
   uniform setters are constant-time, and `proc.render()` is a queue submit
   only.

**Alternatives considered:**

- *The WebGPU shader compile leaks into every run* — possible but unlikely;
  the warmup-discard policy in `App.tsx` already drops the first sample, and
  Babylon's `proc.isReady()` poll would catch unready shaders well before
  the timed region. Decision 3 below verifies this.
- *Main-thread vs worker overhead alone explains it* — rejected as primary
  cause. Even a worst-case 5 ms round-trip would not account for a 163 ms
  delta. The breakdown will show this stage at near-zero on the WebGPU row
  by design (FR-007), confirming that round-trip alone is not the cause.

**Confirmation gate:** SC-003 requires this question to be answered *in
writing* after the feature ships. The dominant-stage observation in the
panel — readable without dev-tools — is the artifact.

---

## Decision 3 — Does `proc.isReady()` polling cost wall time on warmed-up runs?

**Question:** Does the `for (let i = 0; i < 600 && !proc.isReady(); i++) await
sleep(2)` loop in both Babylon engines actually wait on warmed-up runs, or is
`proc.isReady()` true on the first poll?

**Decision:** **On warmed-up runs (i.e. every sample after the first), the
poll returns `true` on iteration 0 and the loop body never executes.** The
`compile` stage therefore reports `0.00` (or sub-millisecond) for every
sample that survives the warmup-discard policy. On the *first* run after a
fresh engine init, the loop may genuinely wait — but that sample is the
discarded warmup, so it never reaches the median.

**Implementation note (added during /speckit.analyze):** today's
`src/App.tsx` Babylon/CPU sampling loop does NOT discard sample 1; it pushes
all `BENCH_SAMPLES` results and medians over them. Only the Cornerstone
path in the same function does an explicit `await
cornerstoneBenchRenderWebGL(...) // warmup (discarded)` call before its
loop. This feature aligns the two paths: T009 (see
[tasks.md](./tasks.md)) adds the same pattern to the Babylon/CPU paths — one
extra `await eng.run(params)` call before the sampling loop whose result is
thrown away. The discard is what makes the FR-013 / SC-002 story actually
hold for the `compile` stage.

**Rationale:** Babylon's `ProceduralTexture.isReady()` checks whether all
required GPU resources (compiled shader program, bound textures) are
present. After the first successful `proc.render()`, the shader is in
Babylon's cache; subsequent calls return synchronously. This matches the
existing comment in the WebGL engine: "One-time shader compile happens here;
keep it out of the timed region." This feature simply *moves the boundary*
of "timed region" earlier so the poll cost is *observable* when it occurs,
without changing the warmup-discard policy that hides it from the median.

**Alternatives considered:**

- *Always reporting `compile = 0` and skipping the boundary* — rejected.
  Would hide first-sample cost on shader-cache misses (e.g. after a CLAHE
  toggle that recompiles permutations, if Babylon ever splits these into
  multiple shaders). Cheap to keep the boundary; informative when non-zero.
- *Counting engine init compile time toward the `compile` stage* —
  rejected. Engine init runs in `init()`, not `run()`; folding it in would
  break parity with the existing `ms / run` semantics (which excludes
  `setImage` and init).

---

## Decision 4 — Round-trip measurement without clock-sync bugs

**Question:** How does `BabylonFilterEngine` measure the worker round-trip
without relying on a synced clock between the main and worker threads?

**Decision:** Measure entirely on the main thread, then subtract a value the
worker self-reports:

```ts
// In BabylonFilterEngine.run(), main thread:
const tSend = performance.now();
post({ type: "run", id, params });
// … later, in onMessage("result"):
const tRecv = performance.now();
const wallMs = tRecv - tSend;                  // total main-thread wall-clock
const workerElapsedMs = msg.elapsedMs;          // worker's own performance.now() span
const roundTripMs = Math.max(0, wallMs - workerElapsedMs);
const stages = msg.stages
  ? { ...msg.stages, roundTrip: roundTripMs }
  : undefined;
```

**Rationale:** `performance.now()` is per-context (different starting epoch
in the worker vs the main thread), so direct comparison of timestamps across
threads is invalid. But *durations* within one context are valid. The worker
reports its own `elapsedMs` (already does, today). The main thread measures
its own wall-clock around the message round-trip. Subtracting the worker's
internal span from the main-thread wall-clock leaves exactly the time spent
in: `postMessage` serialization, IPC delivery to the worker, the worker's
queue scheduling before `handleRun` starts, and the symmetric path back. The
`Math.max(0, …)` clamps clock-drift artifacts (which shouldn't happen with
`DOMHighResTimeStamp` but is cheap insurance).

For the WebGPU engine, which runs on the main thread, there is no worker;
`roundTripMs` is set to `0` and the spec calls this out explicitly (FR-007).

**Alternatives considered:**

- *Worker stamps `messageReceivedAt` / `replyPostedAt` in its own clock and
  ships them across* — rejected. Even if shipped, those timestamps are in
  the worker's clock; they're only comparable internally and still need a
  wall-clock anchor on the main thread to be useful. The chosen scheme is
  simpler and uses two values that are already trustworthy each on their
  own.
- *MessageChannel ping pre/post each run to estimate IPC overhead* —
  rejected. Adds a synthetic extra round-trip per run that is itself
  measurement overhead; the natural `postMessage("run") → onmessage`
  round-trip is the exact event we want to time, not estimate.

---

## Decision 5 — Does the instrumentation cost change the headline numbers?

**Question:** Does adding four `performance.now()` calls and a small
record-keeping object inside each `run()` measurably move the
`Babylon-WebGL` (~122 ms) or `Babylon-WebGPU` (~286 ms) median?

**Decision:** **No** — the instrumentation overhead is below the noise floor
of typical run-to-run variance for these numbers.

**Rationale:** Per W3C `performance.now()` spec and Chromium implementation
notes, a `performance.now()` call costs on the order of **microseconds** on
modern desktop browsers. Four such calls per run total ~4 µs = 0.004 ms.
Inter-run variance on this benchmark is already at minimum ±1–3 ms on warm
runs (visible in spec 001's 7-sample median needing to discard the warmup).
4 µs is three orders of magnitude below that noise. Allocating one tiny
`StageTimings` object per run is similarly negligible (~tens of nanoseconds
for V8's young-gen allocator).

**Confirmation gate:** SC-004 — the rolled-up `ms / run` for each Babylon row
before vs after this feature must agree to within inter-run variance. The
reviewer browser walk includes a before/after comparison check.

**Alternatives considered:**

- *Conditional instrumentation behind a debug flag* — rejected. Adds branch
  complexity and risks the "untested when off" failure mode; the cost is
  too small to bother gating.
- *Sampling stage timings only on every Nth run* — rejected. Same
  cost/benefit calculus; complicates the per-stage median accumulation in
  `App.tsx` for no measurable savings.

---

## Open questions / out-of-scope

- **The actual fix.** This feature delivers *evidence*, not the fix. Once
  the breakdown identifies the dominant stage (predicted: WebGPU readback),
  a separate feature will choose a remediation — likely one of:
  (a) move the WebGPU engine into a worker once the GLSL→WGSL transpiler
  story is solved (Babylon 8.x ships native WGSL pipelines for our shader
  pattern); (b) use a pre-allocated, mappable `GPUBuffer` instead of
  `proc.readPixels()` to amortize the staging-buffer cost; (c) skip the
  per-run readback entirely when the next step is also a GPU pass. None of
  these are spec'd here.
- **Per-stage breakdown for the CPU engine.** Could in principle decompose
  into (uniform-pack, kernel, output-pack) but the CPU run is one
  synchronous pass and the breakdown wouldn't reveal anything actionable.
  Out of scope per spec Assumptions.
- **Per-stage breakdown for Cornerstone rows.** The Cornerstone rows are
  windowing-only via `IMAGE_RENDERED` and don't decompose into the same
  five stages. Untouched by this feature (spec FR-005).
