import type { FilterParams, StageTimings } from "../types";

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
      /**
       * Per-stage decomposition (4 of 5 stages). Worker emits
       * `compile / upload / compute / readback`; `roundTrip` is filled by
       * `BabylonFilterEngine` on the main thread because the worker has no
       * visibility into its own postMessage overhead.
       */
      stages?: Omit<StageTimings, "roundTrip">;
    }
  | { type: "error"; id?: number; message: string };
