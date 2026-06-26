// Babylon ships the GLSL→WGSL transpiler as UMD assets (CJS default export is a
// factory: (wasmPath) => Promise<instance>). We import them directly and hand
// the instances to WebGPUEngine.initAsync, avoiding the importScripts loader.
declare module "@babylonjs/core/assets/glslang/glslang.js" {
  const factory: (wasmPath: string) => Promise<unknown>;
  export default factory;
}
declare module "@babylonjs/core/assets/twgsl/twgsl.js" {
  const factory: (wasmPath: string) => Promise<unknown>;
  export default factory;
}
