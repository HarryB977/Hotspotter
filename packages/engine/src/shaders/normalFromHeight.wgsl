// Pass 3: Sobel normal from the height map (metres), combined with the
// (already rotated) material normal via Reoriented Normal Mapping.
// When the material has its own normal map, that map already holds the
// material relief, so Sobel runs only on the macro height (groove, bevel and
// wear: everything but the intact material relief); otherwise it runs on the
// full height. With wear, the material detail normal fades towards (0,0,1) by
// wearMask: the lost material takes its relief with it.
// Output is OpenGL convention: +X right, +Y up (image rows grow downwards).

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var matNormalTex: texture_2d<f32>;
@group(0) @binding(3) var outNormal: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var macroTex: texture_2d<f32>;
@group(0) @binding(5) var<uniform> W: Wear;
// 1 × 1 placeholder without wear; read only when W.enabled.
@group(0) @binding(6) var wearMaskTex: texture_2d<f32>;

fn h(p: vec2<i32>) -> f32 {
  let size = vec2<i32>(textureDimensions(heightTex));
  let q = clamp(p, vec2<i32>(0), size - 1);
  if (P.sobelMacro != 0u) {
    if (W.enabled == 0u) {
      // No wear: the macro height is the groove alone, kept as f16 in matNormal.a (v0.1-A output, byte for byte).
      return textureLoad(matNormalTex, q, 0).a;
    }
    return textureLoad(macroTex, q, 0).r;
  }
  return textureLoad(heightTex, q, 0).r;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let p = vec2<i32>(gid.xy);
  let sobelX = (h(p + vec2<i32>(1, -1)) + 2.0 * h(p + vec2<i32>(1, 0)) + h(p + vec2<i32>(1, 1)))
             - (h(p + vec2<i32>(-1, -1)) + 2.0 * h(p + vec2<i32>(-1, 0)) + h(p + vec2<i32>(-1, 1)));
  let sobelRow = (h(p + vec2<i32>(-1, 1)) + 2.0 * h(p + vec2<i32>(0, 1)) + h(p + vec2<i32>(1, 1)))
               - (h(p + vec2<i32>(-1, -1)) + 2.0 * h(p + vec2<i32>(0, -1)) + h(p + vec2<i32>(1, -1)));
  let metresPerPx = 1.0 / (P.ppmRef * P.refScale);
  let dhdx = sobelX / (8.0 * metresPerPx);
  let dhdy = -sobelRow / (8.0 * metresPerPx); // y up
  let base = normalize(vec3<f32>(-dhdx, -dhdy, 1.0));
  var detail = normalize(textureLoad(matNormalTex, p, 0).xyz);
  if (W.enabled != 0u) {
    detail = normalize(mix(detail, vec3<f32>(0.0, 0.0, 1.0), textureLoad(wearMaskTex, p, 0).r));
  }

  // Reoriented Normal Mapping (Barre-Brisebois & Hill).
  let t = base + vec3<f32>(0.0, 0.0, 1.0);
  let u = detail * vec3<f32>(-1.0, -1.0, 1.0);
  let n = normalize(t * dot(t, u) / t.z - u);
  textureStore(outNormal, p, vec4<f32>(n * 0.5 + 0.5, 1.0));
}
