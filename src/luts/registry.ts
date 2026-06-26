import { STD_LUT_SIZE, type Lut } from "./types";

/**
 * In-memory LUT registry + built-in demo tone curves.
 *
 * The built-ins are *approximations* so the preset UI works out of the box.
 * Replace them with validated tables by loading files (see loadLut.ts) — a
 * loaded LUT with the same id overrides the built-in.
 */

const registry = new Map<string, Lut>();

/** Build a LUT from a continuous f(x): [0,1] → [0,1], sampled at STD_LUT_SIZE. */
export function lutFromFn(id: string, name: string, f: (x: number) => number): Lut {
  const n = STD_LUT_SIZE;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    values[i] = Math.min(1, Math.max(0, f(x)));
  }
  return { id, name, size: n, values };
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// S-curve (sigmoid) centered at `c`, steepness `k`. Adds midtone contrast.
const sigmoid = (x: number, c: number, k: number) => {
  const s = (v: number) => 1 / (1 + Math.exp(-k * (v - c)));
  const lo = s(0);
  const hi = s(1);
  return (s(x) - lo) / (hi - lo);
};

// ---- built-in demo curves -------------------------------------------------

const BUILTINS: Lut[] = [
  lutFromFn("identity", "Identity (off)", (x) => x),

  // Lift soft tissue (dark mids) and gently roll off bright bone — the
  // "see tissue + bone together" look from the After images.
  lutFromFn("bone-tissue", "Bone + Tissue", (x) => {
    const lifted = Math.pow(x, 0.78); // brighten shadows/midtones
    const rolloff = 1 - 0.18 * smoothstep(0.7, 1.0, lifted); // compress highlights
    return lifted * rolloff;
  }),

  // Stronger S-curve — crisp, punchy bone detail.
  lutFromFn("high-contrast", "High Contrast", (x) => sigmoid(x, 0.5, 6)),

  // Aggressive shadow lift — emphasize the soft-tissue silhouette.
  lutFromFn("soft-tissue", "Soft Tissue", (x) => Math.pow(x, 0.55)),

  // Gentle highlight protection for already-bright captures.
  lutFromFn("bone-detail", "Bone Detail", (x) => {
    const s = sigmoid(x, 0.62, 5);
    return 0.5 * s + 0.5 * x; // blend toward identity so it stays natural
  }),
];

for (const l of BUILTINS) registry.set(l.id, l);

// ---- registry API ---------------------------------------------------------

export function getLut(id: string): Lut | undefined {
  return registry.get(id);
}

export function listLuts(): Lut[] {
  return [...registry.values()];
}

/** Add or replace a LUT (e.g. a freshly loaded validated table). */
export function addLut(lut: Lut): void {
  registry.set(lut.id, lut);
}
