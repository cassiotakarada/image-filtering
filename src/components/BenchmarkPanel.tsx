import { Fragment } from "react";
import type { StageTimings } from "../engine";

export interface BenchRow {
  /**
   * Discriminator for the benchmark row. The five values lock the table's
   * row set (see specs/001-cornerstone-engines/contracts/benchmark-rows.md C-1):
   *   "babylon"            — Babylon (WebGL, worker)
   *   "cornerstone-webgl"  — Cornerstone (WebGL)
   *   "webgpu"             — Babylon (WebGPU, main thread)
   *   "cornerstone-webgpu" — Cornerstone (WebGPU)  [permanent placeholder]
   *   "cpu"                — CPU (JavaScript), speedup baseline
   */
  kind:
    | "babylon"
    | "webgpu"
    | "cpu"
    | "cornerstone-webgl"
    | "cornerstone-webgpu";
  name: string;
  /** Median ms over the sampled runs, or null if engine unavailable. */
  ms: number | null;
  /** Optional caveat shown after the row (e.g. windowing-only). */
  note?: string;
  /** Graphics backend label (e.g. "WebGL2"). */
  backend?: string;
  /**
   * Per-stage medians (same BENCH_SAMPLES window + warmup-discard as `ms`).
   * Filled ONLY for `kind: "babylon"` and `kind: "webgpu"` rows. MUST be
   * undefined on `cpu`, `cornerstone-webgl`, `cornerstone-webgpu`, and on
   * any Babylon row whose `ms` is `null` (engine unavailable).
   */
  stages?: StageTimings;
}

interface Props {
  rows: BenchRow[] | null;
  size: number;
  samples: number;
}

export function BenchmarkPanel({ rows, size, samples }: Props) {
  if (!rows) {
    return (
      <div className="bench empty">
        <p>Run the benchmark to compare engines on the current filter settings.</p>
      </div>
    );
  }

  const cpu = rows.find((r) => r.kind === "cpu")?.ms ?? null;

  return (
    <div className="bench">
      <h3>
        Benchmark — {size}×{size}, median of {samples} runs
      </h3>
      <table>
        <thead>
          <tr>
            <th>Engine</th>
            <th>Backend</th>
            <th>ms / run</th>
            <th>vs CPU</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // Only Babylon/CPU do the SAME work, so only their ratio is a real
            // speedup. Cornerstone does windowing only — comparing it to the
            // full-pipeline CPU number would be meaningless, so we don't.
            const comparable = r.kind === "babylon" || r.kind === "webgpu";
            const speedup =
              comparable && r.ms != null && cpu != null && r.ms > 0
                ? (cpu / r.ms).toFixed(1) + "×"
                : "—";
            // Stage breakdown sub-row: only the two Babylon rows surface it,
            // and only when the engine produced a real `ms` (otherwise `stages`
            // is undefined). See contracts/stage-breakdown.md C-2.
            const showStages = comparable && r.stages != null;
            return (
              <Fragment key={r.kind}>
                <tr>
                  <td>
                    {r.name}
                    {r.note ? <span className="note"> · {r.note}</span> : null}
                  </td>
                  <td>{r.backend ?? "—"}</td>
                  <td>{r.ms != null ? r.ms.toFixed(2) : "n/a"}</td>
                  <td>{r.kind === "cpu" ? "baseline" : speedup}</td>
                </tr>
                {showStages ? (
                  <tr className="stages-row">
                    <td colSpan={4} className="stages">
                      <span className="stages-arrow">↳</span> compile{" "}
                      {r.stages!.compile.toFixed(2)} · upload{" "}
                      {r.stages!.upload.toFixed(2)} · compute{" "}
                      {r.stages!.compute.toFixed(2)} · readback{" "}
                      {r.stages!.readback.toFixed(2)} · round-trip{" "}
                      {r.stages!.roundTrip.toFixed(2)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        Each Babylon row's <code>ms / run</code> decomposes into five stages
        rendered on the sub-line beneath it (per-stage medians over the same{" "}
        {samples}-sample window, computed independently). <b>compile</b> is the
        wait for the filter shader to become ready inside <code>run()</code>{" "}
        (usually 0 after warmup). <b>upload</b> covers per-run uniform setters,
        the CLAHE map (re)build when CLAHE &gt; 0, and the LUT swap. <b>compute</b>{" "}
        is the <code>proc.render()</code> GPU command submit. <b>readback</b> is{" "}
        <code>await proc.readPixels()</code>, including the implicit GPU sync
        that resolves it. <b>round-trip</b> is the main↔worker postMessage
        overhead (always 0 on the WebGPU row — it runs on the main thread by
        design, because Babylon's GLSL→WGSL transpiler can't be loaded from a
        module worker). The first four stages sum to <code>ms / run</code>
        within ~5%; round-trip is reported separately because it's outside the
        engine's internal timed region. CPU and the two Cornerstone rows do
        not show a breakdown: CPU runs as a single synchronous pass, and
        Cornerstone does windowing only via <code>IMAGE_RENDERED</code> and
        doesn't decompose into the Babylon-shaped stages — that's why their
        "vs CPU" column stays <code>—</code> too. The Cornerstone (WebGPU) row
        is always <code>n/a</code> because Cornerstone3D's pinned version
        (4.15) has no WebGPU backend; the row is kept as a permanent
        placeholder to document the environment and will populate
        automatically once upstream support lands.
      </p>
    </div>
  );
}
