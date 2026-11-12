// Wear height composite: sculpts the loss into the single height field (CLAUDE.md rule 2) and writes the final
// height, the final macro height and wearMask. Runs only with wear (W.enabled); `height` and `macroHeight` are
// updated in place. Everything is in metres on rect-local coordinates, so the result does not depend on the output
// resolution.
//
//   in the loss (b < 0):        h = hMat − depth · s + microM · (fbm(local / 0.002) − 0.5) · s,  s = smoothstep(0, bandM, −b)
//   fracture band (0 < b < bandM): h −= 0.15 · depth · crack · envelope   (fine voronoi cracks around each break)
//   no layer loss (dent):        h −= depth
//   limits:                      h ≥ hMat − depthM − 0.5 · microM (R32c), and never below the groove floor (R32b)
//   macro = hGroove + (h − hMat), wearMask = s
//
// The micro term and the crack envelope fade to 0 at the contour and at the band edge, so neither leaves a one-pixel
// step. The groove floor (id 0, or lossR < 0 inside a rect, R31) is never touched.

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

// bandM floor, injected from MIN_BAND_M (wear.ts) so a zero band stays a valid smoothstep range.
override MIN_BAND_M: f32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  // loss and border are 1 × 1 placeholders without wear.
  if (W.enabled == 0u) { return; }
  let c = vec2<i32>(gid.xy);
  let id = textureLoad(rectIdTex, c, 0).r;
  let ld = unpack2x16float(textureLoad(lossTex, c, 0).r);
  if (id == 0u || ld.x < 0.0) {
    textureStore(outWearMask, c, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let pl = rects[id - 1u];
  let px = (vec2<f32>(gid.xy) + 0.5) / P.refScale;
  let local = wearLocalM(id, pl.rect, px, P.ppmRef, P.seed);
  let depth = ld.y;
  let b = textureLoad(borderTex, c, 0).r;
  let bandM = max(W.bandM, MIN_BAND_M);
  let hMat = textureLoad(heightTex, c).r;

  var h = hMat;
  var s = 0.0;
  if (b < 0.0) {
    s = smoothstep(0.0, bandM, -b);
    h = hMat - depth * s + W.microM * (fbm(local / 0.002, 4u, P.seed ^ S_MICRO) - 0.5) * s;
  } else {
    if (b < bandM) {
      let cellM = 0.25 * bandM;
      let v = voronoi(local / cellM, 1.0, P.seed ^ S_CRACK);
      // Anti-aliased: the crack is at least one pixel wide, with its amplitude scaled down to keep its volume (R32d).
      let width = max(0.15, 1.0 / (P.ppmRef * P.refScale * cellM));
      let crack = (1.0 - smoothstep(0.0, width, v.d2 - v.d1)) * (0.15 / width);
      let t = b / bandM;
      let envelope = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.5, 1.0, t));
      h -= 0.15 * depth * crack * envelope;
    }
    // Families without layer loss (dent) only press the surface down by their soft depth.
    if (W.loses == 0u) { h -= depth; }
  }
  h = max(h, hMat - W.depthM - 0.5 * W.microM);
  // A break never digs below the groove floor; material already below it stays as it is.
  h = max(h, min(hMat, -P.grooveDepthM));

  let macroH = textureLoad(macroTex, c).r + (h - hMat);
  textureStore(heightTex, c, vec4<f32>(h, 0.0, 0.0, 1.0));
  textureStore(macroTex, c, vec4<f32>(macroH, 0.0, 0.0, 1.0));
  textureStore(outWearMask, c, vec4<f32>(s, s, s, 1.0));
}
