/// <reference types="vite/client" />

// Emscripten glue for the OpenJPEG JPEG-2000 decoder (self-contained build with
// the wasm inlined; no shipped types).
declare module "@cornerstonejs/codec-openjpeg/decode" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (opts?: any) => Promise<any>;
  export default factory;
}
