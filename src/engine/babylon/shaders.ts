/**
 * Combined enhancement pass (GLSL, for Babylon ProceduralTexture).
 *
 * Pipeline per pixel (3x3 neighbourhood), all in windowed [0,1] space:
 *   window (brightness/contrast) → CLAHE local contrast → denoise → unsharp
 *   sharpen → gamma → LUT tone curve → edge → invert
 *
 * The source texture holds RAW stored values (e.g. CT HU, possibly negative).
 * We window them to [0,1] with (winLow, winWidth) — that windowing IS the
 * brightness/contrast control. CLAHE then adds *local* contrast that no point
 * operation can (its per-tile maps are precomputed on the CPU and uploaded as
 * `claheTex`; here we just bilinearly interpolate the four surrounding tiles).
 * The output is mapped to 0..OUTPUT_MAX and displayed linearly. The CPU engine
 * implements identical math (see clahe.ts `sampleClahe`).
 */
export const FILTER_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;

uniform sampler2D src;
uniform sampler2D lut;    // 1-D tone curve (width=N, height=1), R channel
uniform sampler2D claheTex; // per-tile CDF maps: width=bins, height=tilesX*tilesY
uniform vec2 texel;       // (1/width, 1/height)
uniform float winLow;     // window lower bound (stored units)
uniform float winWidth;   // window width (stored units)
uniform float claheFlag;  // 0 or 1 — apply CLAHE
uniform float claheAmt;   // CLAHE strength (blend windowed↔equalized)
uniform vec2 claheTilePx; // tile size in pixels (w/tilesX, h/tilesY)
uniform vec2 claheGrid;   // (tilesX, tilesY)
uniform float claheBins;  // bins per tile map
uniform float claheRows;  // tilesX*tilesY
uniform float denoiseAmt; // 0 = off
uniform float sharpenAmt; // 0 = off
uniform float edgeAmt;    // 0 = off
uniform float gammaVal;   // 1 = off
uniform float invertFlag; // 0 or 1
uniform float lutFlag;    // 0 or 1 — apply tone-curve LUT
uniform float outMax;     // OUTPUT_MAX

// Tissue segmentation (classify by the WINDOWED value, before CLAHE).
uniform float segFlag;
uniform float segT1;      // tissue|bone boundary
uniform float segT2;      // bone|tooth boundary
uniform float segFeather; // soft transition half-width
uniform float segTissueGain;
uniform float segTissueBias;
uniform float segBoneGain;
uniform float segToothGain;
uniform float segToothBias;
uniform float segView;    // 0 normal, 1 class-map
uniform float segTint;    // 0/1 faint tint in normal view
uniform vec3 segColTissue;
uniform vec3 segColBone;
uniform vec3 segColTooth;

// Lookup value v in one tile's CDF map (row = tile index). NEAREST-sampled
// texture, so we interpolate between bins ourselves for smoothness.
float claheMapTile(float row, float v) {
  float x = v * (claheBins - 1.0);
  float i0 = floor(x);
  float f = x - i0;
  float i1 = min(i0 + 1.0, claheBins - 1.0);
  float vrow = (row + 0.5) / claheRows;
  float a = texture2D(claheTex, vec2((i0 + 0.5) / claheBins, vrow)).r;
  float b = texture2D(claheTex, vec2((i1 + 0.5) / claheBins, vrow)).r;
  return mix(a, b, f);
}

// Bilinear blend of the four tile maps surrounding this pixel (matches
// clahe.ts sampleClahe — tile centers sit at (t+0.5)*tile).
float claheAt(vec2 uv, float v) {
  vec2 px = uv / texel;
  float fx = px.x / claheTilePx.x - 0.5;
  float fy = px.y / claheTilePx.y - 0.5;
  float tx0 = floor(fx), wx = fx - floor(fx);
  float ty0 = floor(fy), wy = fy - floor(fy);
  float tx1 = clamp(tx0 + 1.0, 0.0, claheGrid.x - 1.0);
  float ty1 = clamp(ty0 + 1.0, 0.0, claheGrid.y - 1.0);
  tx0 = clamp(tx0, 0.0, claheGrid.x - 1.0);
  ty0 = clamp(ty0, 0.0, claheGrid.y - 1.0);
  float a = claheMapTile(ty0 * claheGrid.x + tx0, v);
  float b = claheMapTile(ty0 * claheGrid.x + tx1, v);
  float c = claheMapTile(ty1 * claheGrid.x + tx0, v);
  float d = claheMapTile(ty1 * claheGrid.x + tx1, v);
  return mix(mix(a, b, wx), mix(c, d, wx), wy);
}

// Windowed [0,1] sample, with optional CLAHE local-contrast blended in.
float sampleSrc(vec2 uv) {
  float v = clamp((texture2D(src, uv).r - winLow) / winWidth, 0.0, 1.0);
  if (claheFlag > 0.5) {
    v = mix(v, claheAt(uv, v), claheAmt);
  }
  return v;
}

void main(void) {
  // Windowed center value WITHOUT CLAHE — the basis for segmentation, so class
  // identity follows real density rather than locally-equalized contrast.
  float v0 = clamp((texture2D(src, vUV).r - winLow) / winWidth, 0.0, 1.0);

  float c  = sampleSrc(vUV);
  float l  = sampleSrc(vUV + vec2(-texel.x, 0.0));
  float r  = sampleSrc(vUV + vec2( texel.x, 0.0));
  float u  = sampleSrc(vUV + vec2(0.0, -texel.y));
  float d  = sampleSrc(vUV + vec2(0.0,  texel.y));
  float tl = sampleSrc(vUV + vec2(-texel.x, -texel.y));
  float tr = sampleSrc(vUV + vec2( texel.x, -texel.y));
  float bl = sampleSrc(vUV + vec2(-texel.x,  texel.y));
  float br = sampleSrc(vUV + vec2( texel.x,  texel.y));

  // 3x3 box blur, reused for denoise + unsharp.
  float blur = (c + l + r + u + d + tl + tr + bl + br) / 9.0;

  // 1) denoise (blend toward blur), then 2) unsharp using original high-freq.
  float base = mix(c, blur, denoiseAmt);
  float outv = base + sharpenAmt * (c - blur);
  outv = clamp(outv, 0.0, 1.0);

  // 3) gamma
  outv = pow(outv, 1.0 / gammaVal);

  // 3b) tone-curve LUT (validated bone/tissue mapping). Sample the curve at the
  // current intensity; the LUT texture uses linear filtering so this is a
  // smooth lookup.
  if (lutFlag > 0.5) {
    outv = texture2D(lut, vec2(clamp(outv, 0.0, 1.0), 0.5)).r;
  }

  // 4) Sobel edge magnitude, blended in
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * d + br) - (tl + 2.0 * u + tr);
  float e = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  outv = mix(outv, e, edgeAmt);

  // 5) invert
  outv = mix(outv, 1.0 - outv, invertFlag);

  // 6) tissue segmentation — per-class contrast/brightness + optional color.
  // Soft membership from smoothstep transitions around the two thresholds.
  vec3 rgb = vec3(outv);
  if (segFlag > 0.5) {
    float aBone  = smoothstep(segT1 - segFeather, segT1 + segFeather, v0);
    float aTooth = smoothstep(segT2 - segFeather, segT2 + segFeather, v0);
    float wTooth  = aTooth;
    float wBone   = aBone * (1.0 - aTooth);
    float wTissue = 1.0 - aBone;

    float gain = wTissue * segTissueGain + wBone * segBoneGain + wTooth * segToothGain;
    float bias = wTissue * segTissueBias + wTooth * segToothBias;
    outv = clamp((outv - 0.5) * gain + 0.5 + bias, 0.0, 1.0);

    vec3 cls = wTissue * segColTissue + wBone * segColBone + wTooth * segColTooth;
    if (segView > 0.5) {
      rgb = cls * (0.35 + 0.65 * outv); // class hue, anatomy as brightness
    } else if (segTint > 0.5) {
      rgb = outv * mix(vec3(1.0), cls, 0.3);
    } else {
      rgb = vec3(outv);
    }
  }

  gl_FragColor = vec4(rgb * outMax, 1.0);
}
`;
