import type { FilterEngine, FilterParams, FilterResult, ImageBuffer } from "../types";
import type { Lut } from "../../luts/types";
import type { FromWorker, ToWorker } from "./protocol";

/**
 * Main-thread proxy for the Babylon GPU filter engine. Owns the worker and
 * turns its message protocol into the FilterEngine promise API.
 */
export class BabylonFilterEngine implements FilterEngine {
  readonly name: string;
  backend?: string;
  /** GPU renderer string reported by the WebGL context, if exposed. */
  renderer?: string;

  private readonly backendKind: "webgl" | "webgpu";
  private worker: Worker | null = null;
  private available = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: FilterResult) => void; reject: (e: Error) => void }
  >();
  /**
   * Main-thread `performance.now()` taken immediately before `post({type:"run"})`,
   * keyed by run id. Used to compute the `roundTrip` stage (spec 002, contract
   * C-1) as `max(0, (tRecv - tSend) - worker.elapsedMs)`. Parallel to `pending`
   * — entries are removed in the same code paths (resolve / reject / dispose).
   */
  private runSendAt = new Map<number, number>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private imageSetResolve: (() => void) | null = null;

  constructor(opts: { backend?: "webgl" | "webgpu"; name?: string } = {}) {
    this.backendKind = opts.backend ?? "webgl";
    this.name = opts.name ?? "Babylon (GPU, worker)";
  }

  isAvailable() {
    return this.available;
  }

  init(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(
          new URL("./babylon.worker.ts", import.meta.url),
          { type: "module" }
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      this.worker.onmessage = (ev: MessageEvent<FromWorker>) =>
        this.onMessage(ev.data);
      this.worker.onerror = (ev) => {
        const err = new Error(ev.message || "Babylon worker error");
        this.readyResolve = null;
        this.readyReject = null;
        reject(err);
      };

      this.readyResolve = () => {
        this.available = true;
        resolve();
      };
      this.readyReject = (e: Error) => reject(e);
      this.post({ type: "init", backend: this.backendKind });
    });
  }

  setImage(img: ImageBuffer): Promise<void> {
    // Copy so the caller keeps ownership of its buffer after we transfer.
    const copy = img.data.slice();
    return new Promise<void>((resolve) => {
      this.imageSetResolve = resolve;
      this.post(
        {
          type: "setImage",
          width: img.width,
          height: img.height,
          min: img.min,
          max: img.max,
          defaultCenter: img.defaultCenter,
          defaultWidth: img.defaultWidth,
          data: copy,
        },
        [copy.buffer]
      );
    });
  }

  registerLut(lut: Lut): void {
    // Copy so the registry keeps ownership after we transfer to the worker.
    const values = lut.values.slice();
    this.post(
      { type: "setLut", id: lut.id, size: lut.size, values },
      [values.buffer]
    );
  }

  run(params: FilterParams): Promise<FilterResult> {
    const id = this.nextId++;
    return new Promise<FilterResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Capture send-side wall-clock so the main thread can attribute the
      // round-trip overhead (post → onmessage minus worker-side elapsedMs)
      // — see spec 002 C-1 `roundTrip`.
      this.runSendAt.set(id, performance.now());
      this.post({ type: "run", id, params });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.available = false;
    this.pending.clear();
    this.runSendAt.clear();
  }

  private post(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(msg: FromWorker) {
    switch (msg.type) {
      case "ready":
        this.backend = msg.backend ?? (this.backendKind === "webgpu" ? "WebGPU" : "WebGL");
        this.renderer = msg.renderer;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        break;
      case "initError": {
        const err = new Error(msg.message);
        this.readyReject?.(err);
        this.readyResolve = null;
        this.readyReject = null;
        break;
      }
      case "imageSet":
        this.imageSetResolve?.();
        this.imageSetResolve = null;
        break;
      case "result": {
        // Capture receive-time first so roundTrip excludes the resolve() work.
        const tRecv = performance.now();
        const p = this.pending.get(msg.id);
        if (!p) {
          this.runSendAt.delete(msg.id);
          return;
        }
        this.pending.delete(msg.id);
        const tSend = this.runSendAt.get(msg.id);
        this.runSendAt.delete(msg.id);
        // roundTrip = wall-clock around the postMessage pair MINUS the worker's
        // self-reported elapsedMs (which is the time the worker spent inside
        // run()). Clamped at 0 to absorb clock-noise on warm runs where the
        // worker reports a slightly larger elapsedMs than the main thread saw.
        // See spec 002 research.md Decision 4.
        const stages =
          msg.stages && tSend != null
            ? {
                ...msg.stages,
                roundTrip: Math.max(0, tRecv - tSend - msg.elapsedMs),
              }
            : undefined;
        p.resolve({
          data: msg.data,
          width: msg.width,
          height: msg.height,
          components: msg.components,
          min: msg.min,
          max: msg.max,
          elapsedMs: msg.elapsedMs,
          stages,
        });
        break;
      }
      case "error": {
        const err = new Error(msg.message);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.reject(err);
          this.pending.delete(msg.id);
          this.runSendAt.delete(msg.id);
        } else {
          // Surface init/setImage failures.
          console.error("[BabylonFilterEngine]", err);
        }
        break;
      }
    }
  }
}
