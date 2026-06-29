import { Fragment } from "react";
import type { LiveMode } from "../engine";
import { LIVE_MODE_DESCRIPTIONS } from "../engine";

/**
 * One row in the open+parse+render benchmark. Each row times the full
 * wall-clock from a `File` handle to pixels on screen.
 *
 * `kind` is a `LiveMode` so the row maps 1:1 to a selection in the engine
 * menu — clicking "use" on a row activates that combination as the live
 * viewer.
 *
 * The full 9-row set (per Option B restructure):
 *   "babylon-only-webgl"     — dicom-parser → babylon WebGL → babylon canvas
 *   "babylon-only-webgpu"    — dicom-parser → babylon WebGPU → babylon canvas
 *   "babylon-cs-full-webgl"  — cs wadouri → babylon WebGL → Fabric.js display
 *   "babylon-cs-full-webgpu" — cs wadouri → babylon WebGPU → Fabric.js display
 *   "babylon-cs-parse-webgl" — cs wadouri → babylon WebGL → babylon canvas
 *   "babylon-cs-parse-webgpu"— cs wadouri → babylon WebGPU → babylon canvas
 *   "cornerstone-webgl"      — cs wadouri → cornerstone display
 *   "cornerstone-webgpu"     — permanent n/a placeholder
 *   "cpu"                    — dicom-parser → cpu → cornerstone display
 */
export interface BenchRow {
  kind: LiveMode;
  /** Renderer + display label (e.g. "Babylon (WebGL) · babylon canvas"). */
  name: string;
  /** Parser label ("Cornerstone wadouri", "dicom-parser", or "—"). */
  parser: string;
  /** Median wall-clock ms over the sampled runs, or null if the row failed. */
  ms: number | null;
  /** Graphics backend label (e.g. "WebGL2"). */
  backend?: string;
  /** Optional caveat shown after the row (e.g. failure reason). */
  note?: string;
}

interface Props {
  rows: BenchRow[] | null;
  samples: number;
  /**
   * Short description of what was benchmarked (e.g. file name + dimensions).
   * Surfaced in the header so the user knows which slice the numbers came from.
   */
  subject: string | null;
  /** Currently active live mode — used to highlight the row in the table. */
  liveMode: LiveMode;
  /**
   * Called when the user clicks "use" on a row. The permanent-n/a row
   * (cornerstone-webgpu) suppresses its own button, so this is only ever
   * called with a usable mode.
   */
  onUseMode: (mode: LiveMode) => void;
  /** Disable interaction (used while the bench is mid-run). */
  busy: boolean;
}

export function BenchmarkPanel({
  rows,
  samples,
  subject,
  liveMode,
  onUseMode,
  busy,
}: Props) {
  if (!rows) {
    return (
      <div className="bench empty">
        <p>
          Load a DICOM folder, then run the benchmark to compare end-to-end
          open+parse+render time across libraries.
        </p>
      </div>
    );
  }

  // Compare each row to the Cornerstone (WebGL) full-pipeline number — the
  // reference baseline for "how fast does an established viewer get a DICOM
  // on screen". Falls back to the CPU row if Cornerstone is unavailable.
  const baseline =
    rows.find((r) => r.kind === "cornerstone-webgl")?.ms ??
    rows.find((r) => r.kind === "cpu")?.ms ??
    null;

  return (
    <div className="bench">
      <h3>
        End-to-end · median of {samples} runs
        {subject ? <span className="note"> · {subject}</span> : null}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Renderer</th>
            <th>Parser</th>
            <th>Backend</th>
            <th>ms / run</th>
            <th>vs CS-WebGL</th>
            <th>Use</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // Speedup only meaningful when both this row and the baseline
            // produced a real time. ">1×" = faster than Cornerstone, "<1×" =
            // slower. The baseline row itself shows "baseline".
            let vsCol: string;
            if (r.kind === "cornerstone-webgl") {
              vsCol = "baseline";
            } else if (r.ms != null && baseline != null && r.ms > 0) {
              vsCol = (baseline / r.ms).toFixed(2) + "×";
            } else {
              vsCol = "—";
            }
            const active = r.kind === liveMode;
            // The permanent-n/a row (cornerstone-webgpu) can't drive a live
            // view, so we suppress its "use" button.
            const useable = r.kind !== "cornerstone-webgpu";
            return (
              <Fragment key={r.kind}>
                <tr className={active ? "bench-row active" : "bench-row"}>
                  <td>{r.name}</td>
                  <td>{r.parser}</td>
                  <td>{r.backend ?? "—"}</td>
                  <td>{r.ms != null ? r.ms.toFixed(1) : "n/a"}</td>
                  <td>{vsCol}</td>
                  <td className="use-cell">
                    {useable ? (
                      <button
                        className={"use-btn" + (active ? " active" : "")}
                        disabled={busy || active}
                        onClick={() => onUseMode(r.kind)}
                        title={LIVE_MODE_DESCRIPTIONS[r.kind]}
                      >
                        {active ? "active" : "use"}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {r.note ? (
                  <tr className="note-row">
                    <td colSpan={6} className="note-cell">
                      <span className="note-arrow">↳</span> {r.note}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <details className="bench-hint">
        <summary>What does this measure?</summary>
        <p className="hint">
          Each row is the wall-clock time to go from a <code>File</code> handle
          to pixels on screen: open the file's bytes, parse the DICOM (with the
          library named in the <b>Parser</b> column), and render it (with the
          library named in the <b>Renderer</b> column).{" "}
          <b>babylon canvas</b> rows render via Babylon's own swapchain (no
          readback to CPU, no second pass through Cornerstone).{" "}
          <b>cornerstone display</b> rows hand the filter's pixel buffer back
          to a Cornerstone StackViewport, which adds a GPU→CPU readback plus a
          second on-screen render.{" "}
          <b>Babylon + CS + Fabric</b> rows are the CSOI-Web target flow:
          Cornerstone parses the DICOM, Babylon (direct engine) does the
          filter math straight into its own canvas, and that canvas is
          drawImage'd into a Fabric.js backgroundImage (so downstream code
          can attach annotation tools / overlays via Fabric instead of
          Cornerstone's tool stack). No readPixels or Float32 → Uint8
          conversion — the Babylon→Fabric copy stays canvas-to-canvas. <i>Cornerstone wadouri</i> uses{" "}
          <code>@cornerstonejs/dicom-image-loader</code> (the worker-based
          official path); <i>dicom-parser</i> uses the in-house single-file
          loader. The Cornerstone (WebGPU) row is always <code>n/a</code>{" "}
          because Cornerstone3D 4.15.x has no WebGPU backend. Click <b>use</b>{" "}
          on any row to switch the live view to that combination.
        </p>
      </details>
    </div>
  );
}

