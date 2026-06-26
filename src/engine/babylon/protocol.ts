import type { FilterParams } from "../types";

/** Messages from main thread → worker. */
export type ToWorker =
  | { type: "init"; backend?: "webgl" | "webgpu" }
  | {
      type: "setImage";
      width: number;
      height: number;
      min: number;
      max: number;
      defaultCenter: number;
      defaultWidth: number;
      data: Float32Array; // transferred
    }
  | {
      type: "setLut";
      id: string;
      size: number;
      values: Float32Array; // transferred
    }
  | { type: "run"; id: number; params: FilterParams };

/** Messages from worker → main thread. */
export type FromWorker =
  | { type: "ready"; backend?: string; renderer?: string }
  | { type: "initError"; message: string }
  | { type: "imageSet" }
  | {
      type: "result";
      id: number;
      width: number;
      height: number;
      components: 1 | 3;
      min: number;
      max: number;
      elapsedMs: number;
      data: Float32Array; // transferred
    }
  | { type: "error"; id?: number; message: string };
