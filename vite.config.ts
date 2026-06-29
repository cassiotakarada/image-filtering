import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Pre-bundle the parser + the cornerstone WASM codec glue. Pre-bundling
  // (NOT excluding) applies the CJS→ESM `default` interop the dev server
  // otherwise skips, which is what fixes "no export named 'default'" errors
  // on these glue files. The codec list mirrors what
  // `@cornerstonejs/dicom-image-loader` `import`s by default-export:
  //   - codec-libjpeg-turbo-8bit/decodewasmjs (JPEG baseline 8-bit)
  //   - codec-charls/decodewasmjs            (JPEG-LS)
  //   - codec-openjpeg/decodewasmjs          (JPEG 2000 — loader path)
  //   - codec-openjph/wasmjs                 (HTJ2K)
  // Our own decoder uses `codec-openjpeg/decode` (a different entry in the
  // same package), so both openjpeg entries are listed.
  //
  // BUT exclude `@cornerstonejs/dicom-image-loader` itself: it registers its
  // decode worker via `new URL("./decodeImageFrameWorker.js", import.meta.url)`
  // from inside its own dist, and Vite's dep optimizer doesn't copy worker
  // files into `node_modules/.vite/deps/`, so pre-bundling would produce a
  // broken worker URL. Letting it load straight from `node_modules` keeps the
  // worker resolution intact.
  optimizeDeps: {
    include: [
      "dicom-parser",
      "@cornerstonejs/codec-openjpeg/decode",
      "@cornerstonejs/codec-openjpeg/decodewasmjs",
      "@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs",
      "@cornerstonejs/codec-charls/decodewasmjs",
      "@cornerstonejs/codec-openjph/wasmjs",
    ],
    exclude: ["@cornerstonejs/dicom-image-loader"],
  },
  worker: {
    format: "es",
  },
});
