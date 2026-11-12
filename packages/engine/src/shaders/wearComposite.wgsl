// Wear height composite: sculpts the loss into the single height field (CLAUDE.md rule 2) and writes the final
// height, the final macro height and wearMask. Runs only with wear (W.enabled); `height` and `macroHeight` are
// updated in place. Everything is in metres on rect-local coordinates, so the result does not depend on the output
// resolution.
//
//   in the loss (b < 0):        h = hMat − depth · s + microM · (fbm(local / 0.002) − 0.5) · s,  s = smoothstep(0, bandM, −b)
//   fracture band (0 < b < bandM): h −= 0.15 · depth · crack · envelope   (fine voronoi cracks around each break)
//   no layer loss (dent):        h −= depth
//   limit:                       h ≥ hMat − depthM
//   macro = hGroove + (h − hMat), wearMask = s
//
// The micro term and the crack envelope fade to 0 at the contour and at the band edge, so neither leaves a one-pixel
// step.

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;
@group(0) @binding(2) var rectIdTex: texture_2d<u32>;
@group(0) @binding(3) var<uniform> W: Wear;
@group(0) @binding(4) var lossTex: texture_2d<u32>;
@group(0) @binding(5) var borderTex: texture_2d<f32>;
@group(0) @binding(6) var heightTex: texture_storage_2d<r32float, read_write>;
@group(0) @binding(7) var macroTex: texture_storage_2d<r32float, read_write>;
@group(0) @binding(8) var outWearMask: texture_storage_2d<rgba8unorm, write>;

const S_MICRO = 0x2545f491u;
const S_CRACK = 0x9e3779b1u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  // loss and border are 1 × 1 placeholders without wear.
  if (W.enabled == 0u) { return; }
  let c = vec2<i32>(gid.xy);
  let id = textureLoad(rectIdTex, c, 0).r;
  if (id == 0u) {
    textureStore(outWearMask, c, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let pl = rects[id - 1u];
  let px = (vec2<f32>(gid.xy) + 0.5) / P.refScale;
  let local = wearLocalM(id, pl.rect, px, P.ppmRef, P.seed);
  let depth = unpack2x16float(textureLoad(lossTex, c, 0).r).y;
  let b = textureLoad(borderTex, c, 0).r;
  let bandM = max(W.bandM, 1e-5);
  let hMat = textureLoad(heightTex, c).r;

  var h = hMat;
  var s = 0.0;
  if (b < 0.0) {
    s = smoothstep(0.0, bandM, -b);
    h = hMat - depth * s + W.microM * (fbm(local / 0.002, 4u, P.seed ^ S_MICRO) - 0.5) * s;
  } else {
    if (b < bandM) {
      let v = voronoi(local / (0.25 * bandM), 1.0, P.seed ^ S_CRACK);
      let crack = 1.0 - smoothstep(0.0, 0.15, v.d2 - v.d1);
      let t = b / bandM;
      let envelope = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.5, 1.0, t));
      h -= 0.15 * depth * crack * envelope;
    }
    // Families without layer loss (dent) only press the surface down by their soft depth.
    if (W.loses == 0u) { h -= depth; }
  }
  h = max(h, hMat - W.depthM);

  let macroH = textureLoad(macroTex, c).r + (h - hMat);
  textureStore(heightTex, c, vec4<f32>(h, 0.0, 0.0, 1.0));
  textureStore(macroTex, c, vec4<f32>(macroH, 0.0, 0.0, 1.0));
  textureStore(outWearMask, c, vec4<f32>(s, s, s, 1.0));
}
