// Pass 2: per-pixel material sampling at real-world scale plus groove profile.
// Two entry points share the mapping; they are split only to stay within the
// default limit of 4 storage textures per shader stage.

struct Rect {
  rect: vec4<f32>,         // x, y, w, h in reference px, top-left origin
  originM: vec2<f32>,
  rotate90: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;
@group(0) @binding(2) var rectIdTex: texture_2d<u32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var tBaseColor: texture_2d<f32>;
@group(0) @binding(5) var tNormal: texture_2d<f32>;
@group(0) @binding(6) var tHeight: texture_2d<f32>;
@group(0) @binding(7) var tRoughness: texture_2d<f32>;
@group(0) @binding(8) var tMetallic: texture_2d<f32>;
@group(0) @binding(9) var tAo: texture_2d<f32>;

// Direct transcription of atlasPxToMaterialM (packages/core/src/placement.ts).
// px is a continuous reference-resolution coordinate, top-left origin.
fn atlasPxToMaterialM(r: vec4<f32>, originM: vec2<f32>, rotate90: u32, px: vec2<f32>) -> vec2<f32> {
  let ppm = P.ppmRef;
  var lx = (px.x - r.x) / ppm;
  var ly = (r.y + r.w - px.y) / ppm;
  if (rotate90 != 0u) {
    let t = lx;
    lx = ly;
    ly = -t;
  }
  return originM + vec2<f32>(lx, ly);
}

// Groove depth fraction: 1 at the groove, 0 at d >= 1.
fn profile(d: f32) -> f32 {
  switch P.profile {
    case 0u: { return 1.0 - d; }
    case 1u: { return 1.0 - smoothstep(0.0, 1.0, d); }
    case 2u: { return select(0.0, 1.0, d < 0.5); }
    default: { return 0.0; }
  }
}

struct Pixel {
  id: u32,
  uv: vec2<f32>,
  rotate90: u32,
  prof: f32,               // profile(d); 1 in groove pixels
}

fn pixel(p: vec2<u32>) -> Pixel {
  let px = (vec2<f32>(p) + 0.5) / P.refScale;
  var out: Pixel;
  out.id = textureLoad(rectIdTex, vec2<i32>(p), 0).r;
  var m: vec2<f32>;
  if (out.id == 0u) {
    // Groove / empty: global material coordinates (y up from the atlas bottom).
    m = vec2<f32>(px.x / P.ppmRef, (P.refHeightPx - px.y) / P.ppmRef);
    out.rotate90 = 0u;
    out.prof = 1.0;
  } else {
    let pl = rects[out.id - 1u];
    let r = pl.rect;
    m = atlasPxToMaterialM(r, pl.originM, pl.rotate90, px);
    out.rotate90 = pl.rotate90;
    // d: distance from the groove floor edge (the shrunk rect edge), normalized over bevelM.
    let half = 0.5 * P.grooveWidthM * P.ppmRef;
    let bevelPx = P.bevelM * P.ppmRef;
    let edgePx = min(
      min(px.x - (r.x + half), (r.x + r.z - half) - px.x),
      min(px.y - (r.y + half), (r.y + r.w - half) - px.y),
    );
    if (bevelPx > 0.0) {
      out.prof = profile(clamp(edgePx / bevelPx, 0.0, 1.0));
    } else {
      out.prof = 0.0;
    }
  }
  // Material origin is the image's bottom-left texel, so v is flipped.
  out.uv = vec2<f32>(m.x / P.tileSizeM.x, 1.0 - m.y / P.tileSizeM.y);
  return out;
}

@group(1) @binding(0) var outBaseColor: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(1) var outMatNormal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var outHeight: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn surface(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let q = pixel(gid.xy);
  let c = vec2<i32>(gid.xy);

  textureStore(outBaseColor, c, textureSampleLevel(tBaseColor, samp, q.uv, 0.0));

  var n = textureSampleLevel(tNormal, samp, q.uv, 0.0).xyz * 2.0 - 1.0;
  if (q.rotate90 != 0u) {
    // Material +X runs along atlas +Y and material +Y along atlas -X.
    n = vec3<f32>(-n.y, n.x, n.z);
  }

  // Macro height: the groove/profile part of the height, without the material's own relief.
  var macroH: f32;
  var h: f32;
  if (q.id == 0u) {
    macroH = -P.grooveDepthM;
    h = macroH;
  } else {
    let raw = textureSampleLevel(tHeight, samp, q.uv, 0.0).r;
    macroH = -P.grooveDepthM * q.prof;
    h = (raw - 0.5) * P.heightScaleM + macroH;
  }
  // Alpha carries the macro height to the normal pass.
  textureStore(outMatNormal, c, vec4<f32>(n, macroH));
  textureStore(outHeight, c, vec4<f32>(h, 0.0, 0.0, 1.0));
}

@group(1) @binding(3) var outRoughness: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(4) var outMetallic: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(5) var outAo: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn scalars(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let q = pixel(gid.xy);
  let c = vec2<i32>(gid.xy);

  var rough = textureSampleLevel(tRoughness, samp, q.uv, 0.0).r;
  if (P.roughnessIsGloss != 0u) { rough = 1.0 - rough; }
  let metal = textureSampleLevel(tMetallic, samp, q.uv, 0.0).r;
  let ao = textureSampleLevel(tAo, samp, q.uv, 0.0).r * (1.0 - 0.5 * q.prof);

  textureStore(outRoughness, c, vec4<f32>(rough, rough, rough, 1.0));
  textureStore(outMetallic, c, vec4<f32>(metal, metal, metal, 1.0));
  textureStore(outAo, c, vec4<f32>(ao, ao, ao, 1.0));
}
