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
            return (
              <tr key={r.kind}>
                <td>
                  {r.name}
                  {r.note ? <span className="note"> · {r.note}</span> : null}
                </td>
                <td>{r.backend ?? "—"}</td>
                <td>{r.ms != null ? r.ms.toFixed(2) : "n/a"}</td>
                <td>{r.kind === "cpu" ? "baseline" : speedup}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        Babylon/CPU time = param upload + compute + GPU→CPU readback (the output
        must be handed off). Both Cornerstone rows time = set VOI + GPU render
        to the canvas via the IMAGE_RENDERED event (no readback) and only do
        windowing — CLAHE/sharpen/segmentation have no Cornerstone equivalent,
        so their "vs CPU" column stays `—`. The Cornerstone (WebGPU) row is
        always `n/a` because Cornerstone3D's pinned version (4.15) has no
        WebGPU backend; the row is kept as a permanent placeholder to document
        the environment and will populate automatically once upstream support
        lands.
      </p>
    </div>
  );
}
