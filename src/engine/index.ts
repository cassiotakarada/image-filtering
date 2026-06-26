export type { FilterEngine, FilterParams, FilterResult, ImageBuffer, StageTimings } from "./types";
export { DEFAULT_FILTERS } from "./types";
export type { Lut } from "../luts/types";
export { BabylonFilterEngine } from "./babylon/BabylonFilterEngine";
export { BabylonWebGPUEngine } from "./babylon/BabylonWebGPUEngine";
export { CpuFilterEngine } from "./cpu/CpuFilterEngine";

export type EngineKind = "babylon" | "webgpu" | "cpu";

export const ENGINE_ORDER: EngineKind[] = ["babylon", "webgpu", "cpu"];
