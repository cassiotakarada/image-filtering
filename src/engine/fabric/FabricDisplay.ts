/**
 * Fabric.js display seam for the `babylon-cs-full-*` live modes.
 *
 * Replaces the previous "hand the filtered Float32 buffer back to a
 * Cornerstone StackViewport" terminal step with "drawImage from the
 * Babylon canvas into a Fabric Canvas backgroundImage." This is the
 * architecture CSOI-Web is moving toward: Cornerstone owns parse +
 * windowing metadata only, the GPU engine owns filter math, and Fabric
 * owns interactive display (so downstream code can attach annotation
 * tools / overlays without going through Cornerstone's tool stack).
 *
 * Data flow (one call to `showFromCanvas`):
 *   1. drawImage from the Babylon direct-engine's canvas into an
 *      offscreen 2D scratch canvas, applying a vertical flip because
 *      `BabylonDirectEngine` renders with GL/WebGPU NDC convention
 *      (vUV=(0,0) at bottom-left → image bottom-up in the framebuffer).
 *   2. The 2D canvas is wrapped as a `FabricImage` and installed as the
 *      Fabric Canvas's `backgroundImage`. The Fabric Canvas is sized to
 *      match (1:1 pixel mapping); CSS scales it to the layout box.
 *
 * Why a 2D canvas in the middle: Fabric's `Image` accepts an
 * `HTMLCanvasElement` directly, so we skip the PNG `toDataURL` roundtrip
 * that CSOI-Web's `loadCanvasImage` uses (PNG encode/decode at 1200×1400
 * costs 50-100ms — irrelevant to the display correctness, ruinous to
 * the benchmark). And `drawImage(canvas, ...)` is a GPU-side copy inside
 * the browser compositor: it avoids the readPixels → Float32 → Uint8
 * conversion path that the worker-offscreen engines would force (the
 * bench measured that path at ~60ms of overhead per frame versus the
 * direct-engine drawImage path at <5ms).
 *
 * No interactive Fabric features (selection, drawing, persistence) are
 * wired up here — that's CSOI-Web's domain. This class is the minimal
 * "display the filtered pixels" surface needed for the spike's live-view
 * and benchmark paths.
 */
import { Canvas as FabricCanvas, FabricImage } from "fabric";

export class FabricDisplay {
  private readonly canvasEl: HTMLCanvasElement;
  /** Reusable offscreen 2D canvas that holds the drawImage'd pixels
   *  before we wrap it as a FabricImage. Recreated when the image size
   *  changes; reused as-is when only the contents change. */
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private fabricCanvas: FabricCanvas | null = null;
  private currentW = 0;
  private currentH = 0;

  constructor(canvasEl: HTMLCanvasElement) {
    this.canvasEl = canvasEl;
  }

  init(): void {
    if (this.fabricCanvas) return;
    // selection / interactive features off: this display is read-only for
    // now. Transparent background so the filter pixels we paint are the
    // only visible content.
    //
    // `enableRetinaScaling: false` is important for quality + perf: by
    // default Fabric multiplies the canvas backing buffer by
    // `devicePixelRatio` (e.g. 1.5 or 2x) and bilinearly upscales our
    // scratch content into it. With our `viewport-fabric` CSS rule that
    // shrinks the canvas back down to ~419px on screen, that means our
    // 1200\u00d71400 pixels would go 1200 \u2192 1800 (bilinear upscale) \u2192 419
    // (bilinear downscale), introducing one extra resampling step
    // compared to the direct-engine path (1200 \u2192 419 in one CSS-bilinear
    // step). Keeping the Fabric canvas at native image dims preserves
    // pixel-perfect fidelity with the direct Babylon canvas path.
    this.fabricCanvas = new FabricCanvas(this.canvasEl, {
      selection: false,
      backgroundColor: "transparent",
      renderOnAddRemove: false,
      enableRetinaScaling: false,
    });
  }

  /**
   * Display the engine's already-rendered canvas as the Fabric Canvas's
   * background image. Idempotent across calls — reuses the scratch
   * canvas when only the pixel values change.
   *
   * `srcCanvas` is expected to be the `BabylonDirectEngine.canvas` (a
   * canvas backed by a WebGL / WebGPU context), with the rendered output
   * still resident in its drawing buffer (i.e. `srcCanvas` was the target
   * of a Babylon draw call earlier in the same frame).
   */
  showFromCanvas(srcCanvas: HTMLCanvasElement, w: number, h: number): void {
    if (!this.fabricCanvas) this.init();
    const fabricCanvas = this.fabricCanvas!;

    // (Re)allocate the scratch canvas when the size changes; reuse otherwise
    // so we don't churn allocations on every slider tweak.
    if (!this.scratch || this.currentW !== w || this.currentH !== h) {
      this.scratch = document.createElement("canvas");
      this.scratch.width = w;
      this.scratch.height = h;
      this.scratchCtx = this.scratch.getContext("2d", { willReadFrequently: false });
      this.currentW = w;
      this.currentH = h;
      // Resize the Fabric canvas to native image dimensions; CSS handles
      // display scaling (see .viewport-fabric in app.css).
      fabricCanvas.setDimensions({ width: w, height: h });
    }
    const ctx = this.scratchCtx;
    if (!ctx) throw new Error("FabricDisplay: 2D context unavailable");

    // BabylonDirectEngine renders a full-screen quad with
    // `vUV = (position + 1) / 2`, so vUV=(0,0) lands at the bottom-left of
    // the framebuffer in GL/WebGPU NDC. The result is the image stored
    // Y-flipped in the canvas backing buffer (medical convention is row 0
    // at top). Flip on the way into the scratch canvas so Fabric draws
    // it right-side-up.
    ctx.save();
    ctx.scale(1, -1);
    ctx.drawImage(srcCanvas, 0, -h, w, h);
    ctx.restore();

    // Wrap the scratch canvas as a FabricImage and install as background.
    // We construct a fresh FabricImage each call: Fabric caches its own
    // internal image source, and trying to swap the source on an existing
    // FabricImage is messier than just replacing the object. The scratch
    // canvas itself is reused, so this is a cheap object allocation, not a
    // pixel copy.
    const bgImage = new FabricImage(this.scratch!, {
      left: 0,
      top: 0,
      selectable: false,
      evented: false,
      originX: "left",
      originY: "top",
    });
    fabricCanvas.backgroundImage = bgImage;
    fabricCanvas.renderAll();
  }

  dispose(): void {
    this.fabricCanvas?.dispose();
    this.fabricCanvas = null;
    this.scratch = null;
    this.scratchCtx = null;
    this.currentW = 0;
    this.currentH = 0;
  }
}
