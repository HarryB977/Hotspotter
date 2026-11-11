// Pass 3: Sobel normal from the height map (metres), combined with the
// (already rotated) material normal via Reoriented Normal Mapping.
// Output is OpenGL convention: +X right, +Y up (image rows grow downwards).

struct Params {
  outSize: vec2<f32>,
  refScale: f32,
  ppmRef: f32,
  tileSizeM: vec2<f32>,
  heightScaleM: f32,
  grooveWidthM: f32,
  grooveDepthM: f32,
  profile: u32,
  roughnessIsGloss: u32,
  refHeightPx: f32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var matNormalTex: texture_2d<f32>;
@group(0) @binding(3) var outNormal: texture_storage_2d<rgba8unorm, write>;

fn h(p: vec2<i32>) -> f32 {
  let size = vec2<i32>(textureDimensions(heightTex));
  return textureLoad(heightTex, clamp(p, vec2<i32>(0), size - 1), 0).r;
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
  let detail = normalize(textureLoad(matNormalTex, p, 0).xyz);

  // Reoriented Normal Mapping (Barre-Brisebois & Hill).
  let t = base + vec3<f32>(0.0, 0.0, 1.0);
  let u = detail * vec3<f32>(-1.0, -1.0, 1.0);
  let n = normalize(t * dot(t, u) / t.z - u);
  textureStore(outNormal, p, vec4<f32>(n * 0.5 + 0.5, 1.0));
}
