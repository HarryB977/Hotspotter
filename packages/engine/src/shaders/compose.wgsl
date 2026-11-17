// Pass 2: per-pixel material sampling at real-world scale plus groove profile: the surface (material normal, height,
// macro height) and the atlas-space structure maps. Colour, roughness, metallic and AO are written later by the colour
// composite (colorComposite.wgsl), once the height is final.

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;
@group(0) @binding(2) var rectIdTex: texture_2d<u32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(5) var tNormal: texture_2d<f32>;
@group(0) @binding(6) var tHeight: texture_2d<f32>;
@group(0) @binding(10) var tPieceId: texture_2d<u32>;
@group(0) @binding(11) var tJointDist: texture_2d<f32>;

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
    m = atlasPxToMaterialM(r, pl.originM, pl.rotate90, px, P.ppmRef);
    out.rotate90 = pl.rotate90;
    // d: distance from the groove floor edge (the shrunk rect edge), normalized over bevelM.
    let bevelPx = P.bevelM * P.ppmRef;
    let edgePx = visibleEdgePx(r, pl.seams, px, 0.5 * P.grooveWidthM * P.ppmRef);
    if (bevelPx > 0.0) {
      out.prof = grooveProfile(P.profile, clamp(edgePx / bevelPx, 0.0, 1.0));
    } else {
      out.prof = 0.0;
    }
  }
  out.uv = materialUv(m, P.tileSizeM);
  return out;
}

@group(1) @binding(1) var outMatNormal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var outHeight: texture_storage_2d<r32float, write>;
@group(1) @binding(8) var outMacroHeight: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn surface(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let q = pixel(gid.xy);
  let c = vec2<i32>(gid.xy);

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
  // Alpha keeps the f16 macro height for the no-wear normal pass, so its output stays byte-identical to v0.1-A;
  // with wear the normal pass reads the final macroHeight instead.
  textureStore(outMatNormal, c, vec4<f32>(n, macroH));
  textureStore(outHeight, c, vec4<f32>(h, 0.0, 0.0, 1.0));
  textureStore(outMacroHeight, c, vec4<f32>(macroH, 0.0, 0.0, 1.0));
}

@group(1) @binding(6) var outPieceId: texture_storage_2d<r32uint, write>;
@group(1) @binding(7) var outJointDist: texture_storage_2d<r32float, write>;

// Nearest texel of a material-space map at uv, wrapping in both axes (no sampler for integer maps).
fn nearestTexel(dims: vec2<u32>, uv: vec2<f32>) -> vec2<i32> {
  return min(vec2<i32>(floor(fract(uv) * vec2<f32>(dims))), vec2<i32>(dims) - 1);
}

@compute @workgroup_size(8, 8)
fn structure(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let q = pixel(gid.xy);
  let c = vec2<i32>(gid.xy);
  var id = 0u;
  var dist = 0.0;
  if (q.id != 0u) {
    // Same uv as `surface`, so piece boundaries line up with the albedo, rotated rects included.
    id = textureLoad(tPieceId, nearestTexel(textureDimensions(tPieceId), q.uv), 0).r;
    dist = textureLoad(tJointDist, nearestTexel(textureDimensions(tJointDist), q.uv), 0).r;
  }
  textureStore(outPieceId, c, vec4<u32>(id, 0u, 0u, 0u));
  textureStore(outJointDist, c, vec4<f32>(dist, 0.0, 0.0, 0.0));
}
