export type { FilterEngine, FilterParams, FilterResult, ImageBuffer, StageTimings } from "./types";
export { DEFAULT_FILTERS } from "./types";
export type { Lut } from "../luts/types";
export { BabylonFilterEngine } from "./babylon/BabylonFilterEngine";
export { BabylonWebGPUEngine } from "./babylon/BabylonWebGPUEngine";
export { BabylonDirectEngine } from "./babylon/BabylonDirectEngine";
export type { DirectBackend, DirectRunResult } from "./babylon/BabylonDirectEngine";
export { CpuFilterEngine } from "./cpu/CpuFilterEngine";
export { FabricDisplay } from "./fabric/FabricDisplay";

/**
 * Legacy engine kind — what *filter* engine to run when display goes through
 * Cornerstone. Still used by the offscreen-render + cornerstone-display
 * pipeline (`applyFilter` in App.tsx for modes that render via Cornerstone).
 *
 * For the full 9-mode live view, see `LiveMode` below. The two coexist
 * because some `LiveMode` values map to an `EngineKind` plus a display
 * routing, while others (babylon-direct, cornerstone-only) bypass
 * `EngineKind` entirely.
 */
export type EngineKind = "babylon" | "webgpu" | "cpu";

export const ENGINE_ORDER: EngineKind[] = ["babylon", "webgpu", "cpu"];

/**
 * One full pipeline configuration. Matches 1:1 with the benchmark row set so
 * the engine menu and the bench results table share the same vocabulary.
 *
 *   babylon-only-*    — dicom-parser + BabylonDirectEngine + babylon canvas.
 *                       No cornerstone anywhere.
 *   babylon-cs-full-* \u2014 cs wadouri loader + BabylonDirectEngine +
 *                       FabricDisplay (drawImage from the direct engine's
 *                       canvas \u2192 fabric scratch \u2192 Fabric backgroundImage).
 *                       Cornerstone is only used for parsing; the filter
 *                       runs in Babylon and the display lives in a Fabric
 *                       Canvas (matches the CSOI-Web direction \u2014 see
 *                       engine/fabric/FabricDisplay.ts).
 *   babylon-cs-parse-*\u2014 cs wadouri loader + BabylonDirectEngine + babylon canvas.
 *                       Same pipeline as -full-* up to the display step;
 *                       differs only in skipping Fabric (paints to the
 *                       Babylon canvas directly). Useful as a "Fabric
 *                       overhead" floor in the bench.
 *   cornerstone-*     — cs wadouri loader + cornerstone display. No babylon.
 *   cpu               — dicom-parser + CpuFilterEngine + cornerstone display.
 *
 * `cornerstone-webgpu` is a permanent placeholder (cornerstone3D 4.15.x has
 * no WebGPU backend).
 *
 * In the LIVE view, parser differences are visually invisible (the same
 * decoded pixels reach the renderer either way). So modes that share a
 * display path render identically. That intentional redundancy lets the user
 * pick any bench row and see its renderer in action.
 */
export type LiveMode =
  | "babylon-only-webgl"
  | "babylon-only-webgpu"
  | "babylon-cs-full-webgl"
  | "babylon-cs-full-webgpu"
  | "babylon-cs-parse-webgl"
  | "babylon-cs-parse-webgpu"
  | "cornerstone-webgl"
  | "cornerstone-webgpu"
  | "cpu";

/** Display order in the engine selector + benchmark panel. */
export const LIVE_MODE_ORDER: LiveMode[] = [
  "babylon-only-webgl",
  "babylon-only-webgpu",
  "babylon-cs-full-webgl",
  "babylon-cs-full-webgpu",
  "babylon-cs-parse-webgl",
  "babylon-cs-parse-webgpu",
  "cornerstone-webgl",
  "cornerstone-webgpu",
  "cpu",
];

/** Render-path classification — what actually paints the visible pixels. */
export function liveModeDisplay(
  m: LiveMode
): "babylon-canvas" | "cornerstone" | "fabric" | "unavailable" {
  if (m === "cornerstone-webgpu") return "unavailable";
  if (
    m === "babylon-only-webgl" ||
    m === "babylon-only-webgpu" ||
    m === "babylon-cs-parse-webgl" ||
    m === "babylon-cs-parse-webgpu"
  )
    return "babylon-canvas";
  if (m === "babylon-cs-full-webgl" || m === "babylon-cs-full-webgpu") return "fabric";
  return "cornerstone";
}

/** Backend used by the BabylonDirectEngine in this mode (if any).
 *
 * Returns webgl/webgpu for every mode where the direct engine is in the
 * pipeline:
 *   - babylon-only-*       \u2014 direct engine paints to its own canvas (display sink)
 *   - babylon-cs-parse-*   \u2014 direct engine paints to its own canvas (display sink)
 *   - babylon-cs-full-*    \u2014 direct engine paints to its (hidden) canvas, which
 *                            FabricDisplay.showFromCanvas drawImages into the
 *                            Fabric scratch (display sink is Fabric)
 *
 * Returns null for cornerstone-* and cpu modes (no direct engine involved). */
export function liveModeDirectBackend(
  m: LiveMode
): "webgl" | "webgpu" | null {
  if (
    m === "babylon-only-webgl" ||
    m === "babylon-cs-parse-webgl" ||
    m === "babylon-cs-full-webgl"
  )
    return "webgl";
  if (
    m === "babylon-only-webgpu" ||
    m === "babylon-cs-parse-webgpu" ||
    m === "babylon-cs-full-webgpu"
  )
    return "webgpu";
  return null;
}

/** Offscreen filter engine used in this mode (if any \u2014 cpu only).
 *
 * Used by the cornerstone-display path to pick the worker-offscreen
 * engine that produces the Float32 buffer Cornerstone then displays.
 * `babylon-cs-full-*` is intentionally NOT in this list \u2014 those modes
 * now use the direct engine + drawImage to Fabric, so they don't need
 * an offscreen filter engine. See `liveModeDirectBackend`. */
export function liveModeOffscreenEngine(m: LiveMode): EngineKind | null {
  if (m === "cpu") return "cpu";
  return null;
}

/** Short label for the engine selector. */
export const LIVE_MODE_LABELS: Record<LiveMode, string> = {
  "babylon-only-webgl": "Babylon only (WebGL)",
  "babylon-only-webgpu": "Babylon only (WebGPU)",
  "babylon-cs-full-webgl": "Babylon + CS + Fabric (WebGL)",
  "babylon-cs-full-webgpu": "Babylon + CS + Fabric (WebGPU)",
  "babylon-cs-parse-webgl": "Babylon (CS parse only, WebGL)",
  "babylon-cs-parse-webgpu": "Babylon (CS parse only, WebGPU)",
  "cornerstone-webgl": "Cornerstone only (WebGL)",
  "cornerstone-webgpu": "Cornerstone only (WebGPU)",
  cpu: "CPU (JavaScript)",
};

/** Long-form description shown in tooltips / hints. */
export const LIVE_MODE_DESCRIPTIONS: Record<LiveMode, string> = {
  "babylon-only-webgl":
    "dicom-parser → Babylon (WebGL) → Babylon canvas. No Cornerstone.",
  "babylon-only-webgpu":
    "dicom-parser → Babylon (WebGPU) → Babylon canvas. No Cornerstone.",
  "babylon-cs-full-webgl":
    "Cornerstone wadouri (parse) → Babylon (WebGL, filter) → Fabric.js display via drawImage. CSOI-Web target flow.",
  "babylon-cs-full-webgpu":
    "Cornerstone wadouri (parse) → Babylon (WebGPU, filter) → Fabric.js display via drawImage. CSOI-Web target flow.",
  "babylon-cs-parse-webgl":
    "Cornerstone wadouri → Babylon (WebGL) → Babylon canvas. CS only parses.",
  "babylon-cs-parse-webgpu":
    "Cornerstone wadouri → Babylon (WebGPU) → Babylon canvas. CS only parses.",
  "cornerstone-webgl":
    "Cornerstone wadouri → Cornerstone display. No Babylon (only window/level).",
  "cornerstone-webgpu":
    "Permanent n/a — Cornerstone3D 4.15.x has no WebGPU backend.",
  cpu: "dicom-parser → CPU JS → Cornerstone display.",
};
