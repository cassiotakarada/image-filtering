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
  // Pre-bundle the parser + the OpenJPEG codec glue. Pre-bundling (NOT
  // excluding) applies the CJS→ESM interop the dev server otherwise skips,
  // which is what fixes the "no export named 'default'" error on the glue.
  optimizeDeps: {
    include: ["dicom-parser", "@cornerstonejs/codec-openjpeg/decode"],
  },
  worker: {
    format: "es",
  },
});
