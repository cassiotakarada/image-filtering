# Babylon Filter Spike

A throwaway proof-of-concept for the **CSOI-Web** filter-architecture study.
It validates whether running DICOM image filters in a **GPU engine (Babylon.js)
behind a Cornerstone3D display seam** is meaningfully faster than the current
CPU/main-thread approach — before any of this touches the regulated codebase.

> ⚠️ Synthetic data only. The phantom is 100% procedurally generated. No PHI/PII
> anywhere — keep it that way.

---

## What it proves

| Claim | How this spike tests it |
| --- | --- |
| **1. GPU filtering is much faster than the current CPU path** | The **Babylon engine** runs the filter graph (unsharp → Sobel edge → gamma → invert) as one GPU pass with a single readback, in a **Web Worker on an OffscreenCanvas**. The **CPU engine** runs byte-identical math on the main thread. The benchmark panel reports median ms and the speedup. |
| **2. Filter output re-enters Cornerstone cleanly (no GPU-context sharing)** | A custom **`filtered:` image loader** + metadata provider feeds the engine's output back into a Cornerstone `StackViewport`. The source loads via the real **`wadouri:`** DICOM decode path. Both display in the same viewport. |

The load-bearing idea is the **`FilterEngine` interface** (`src/engine/types.ts`):
execution is decoupled from display and from any one GPU library, so engines are
swappable and benchmarkable. That is the piece you'd lift into CSOI-Web.

> Out of scope on purpose: ML/learned filters (denoise, super-resolution). Those
> are a separate, heavier track (an ONNX-runtime engine implementing the same
> interface) and were stripped from this spike to keep it focused on the kernel
> filters that are the actual goal.

---

## Architecture

```
 synthetic 16-bit DICOM  ──wadouri:──▶  Cornerstone decode  ──▶  ImageBuffer (Float32, native range)
                                                                      │
                                                                      ▼
                                              ┌──────────  FilterEngine (interface)  ──────────┐
                                              │   BabylonFilterEngine       CpuFilterEngine      │
                                              │   (worker + GPU)            (main thread)         │
                                              └───────────────────────┬──────────────────────────┘
                                                                      │ FilterResult (one readback)
                                                                      ▼
                                              registerFilteredResult()  →  filtered:result-N
                                                                      │
                                                                      ▼
                                                Cornerstone StackViewport (display + window/level)
```

Key decisions (and why):

- **Native bit depth, not 8-bit RGBA.** The image is filtered as Float32 in the
  original value range, then served back as 16-bit. The current Fabric.js path
  filters 8-bit canvas data, which is both slower and diagnostically lossy.
- **One readback.** All filter work stays on the GPU; only the final result is
  read back to CPU. Per-pass readback is the usual reason "GPU felt slow".
- **Worker + OffscreenCanvas.** The whole Babylon engine runs off the main
  thread, so slider drags never block React/Cornerstone — the "lagging" fix.
- **No context sharing.** Babylon and Cornerstone each own their GPU context;
  the seam between them is a cheap typed-array handoff, not a shared texture.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

In the page:

- **Engine** — switch between Babylon and CPU.
- **Filters** — sharpen / gamma / edge / invert sliders apply live (debounced),
  rendering through the selected engine into the Cornerstone viewport.
- **Image → Size** — regenerate the phantom at 512² / 1024² / 2048² to see how
  the GPU↔CPU gap widens with resolution.
- **Run benchmark** — median ms per engine for the current filter settings, plus
  speedup vs the CPU baseline.
- **Show original** — re-display the un-filtered source (the `wadouri:` image).

### Build / type-check

```bash
npm run build        # tsc --noEmit + vite build
npm run type-check
```

---

## ⚠️ I could not run this in a browser

This was authored without a browser to drive, so **the build/type-check is
verified but runtime behaviour is not**. The integration points most worth
watching when you first run `npm run dev` (and the file to look at):

1. **Babylon ProceduralTexture manual render in a worker** —
   `src/engine/babylon/babylon.worker.ts`. If the result is blank, the likely
   culprits are float-texture render support (`EXT_color_buffer_float`) or the
   `proc.isReady()`/`proc.render()` timing. The engine reports compile errors
   back to the console via the worker `error` message.
2. **Synthetic DICOM decode** — `src/dicom/syntheticDicom.ts`. If `wadouri:`
   fails to parse, the hand-rolled Explicit-VR-LE encoder is the first suspect
   (tag ordering / even-length padding / the `OW` PixelData length).
3. **The `filtered:` Cornerstone seam** — `src/dicom/cornerstoneSetup.ts`. If
   the source shows but filtered results don't, the metadata provider modules or
   the image-object shape need adjusting for this Cornerstone version.

These are flagged honestly so you know where to look — ping me with whatever the
console shows and I'll fix.

---

## Porting the win to CSOI-Web

- The `src/engine/` folder is framework-agnostic and ports almost verbatim.
- Swap the barrel `@babylonjs/core` import in the worker for deep
  `@babylonjs/core/...` imports to tree-shake the bundle.
- In CSOI-Web, the source already comes from Cornerstone — you skip the
  synthetic-DICOM generator and feed `image.getPixelData()` straight into
  `FilterEngine.setImage()`.
- Run it through `/spec-driven-development`: freeze a spec for the "GPU filter
  engine" with the legacy-parity + golden-image-validation requirements first
  (per the workspace guardrails).

---

## Layout

```
src/engine/types.ts                FilterEngine interface (the core abstraction)
src/engine/babylon/                GPU engine: worker, shaders, proxy
src/engine/cpu/                    CPU baseline (identical math)
src/dicom/syntheticDicom.ts        procedural phantom + DICOM P10 encoder
src/dicom/cornerstoneSetup.ts      init + wadouri load + filtered: seam
src/components/                    Controls, BenchmarkPanel
src/App.tsx                        wiring
```
