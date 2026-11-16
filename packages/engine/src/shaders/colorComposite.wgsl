// Colour composite: the final baseColor, roughness, metallic and AO, written once the height field is final (after
// the wear height composite). Runs with and without wear. Colour and roughness are composited here and never feed the
// normal (CLAUDE.md rule 2); AO comes from the final height. Everything is sized in metres, so the result does not
// depend on the output resolution.
//
//   substrate (wear, families that lose material), mixed in by wearMask:
//     interior:   HSV of the material colour, h += hueShift (degrees), s *= satMul, v *= valMul,
//                 times 0.9 + 0.2 · fbm(local / 4 mm); roughness + roughAdd
//     second set: the substrate material sampled at the same material metres (Task 6 mapping, rotation included) with
//                 its own tileSizeM
//   edge tone (wear, wEff > 0):  edge = max(bevel profile, 1 − smoothstep(0, bandM, |border|))
//                 v = mix(v, 1, edgeTone · polish · edge), roughness −= 0.3 · edgeTone · polish · edge
//   height AO:    aoH = 1 − clamp(AO_K · Σ_r max(0, mean_8(h at radius r) − h) / r), r = 5, 20, 60 mm, on the full
//                 height, or on the macro height (groove, bevel, wear) when the material ships a real AO map, whose
//                 baked AO already holds the material relief (R33, AO_ON_MACRO)
//   AO:           ao = aoMaterial · aoH
//   runoff:       below the visible top edge of each rect and below each loss of the same rect, within runoffLengthM:
//                 amount = runoff · (1 − smoothstep(0, L, distance below the origin)) · fbm(local.x / 1 cm, local.y / L)
//                 colour = mix(colour, tint · colour, amount)
//   cavity:       k = cavity · (1 − aoMaterial · aoH); colour = mix(colour, tint · colour, k), roughness + 0.1 · k
//
// The groove (rect id 0) and the groove floor inside a rect (lossR < 0, R31) get neither substrate, edge tone nor
// runoff; height AO and cavity dirt apply everywhere.
//
// One invocation walks a chunk of bandOffset.y rows of one column, top to bottom, so it knows the latest loss above
// it in the same rect (runoff from losses). It first walks bandOffset.z rows above the chunk (runoffLengthM in output
// px, 0 when losses cannot tint) reading only rectId and loss. Both are uniforms, not overrides, so a new runoff
// length builds no pipeline.

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;
@group(0) @binding(2) var rectIdTex: texture_2d<u32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> W: Wear;
@group(0) @binding(5) var heightTex: texture_2d<f32>;
// loss, border and wearMask are 1 × 1 placeholders without wear; read only when W.enabled.
@group(0) @binding(6) var lossTex: texture_2d<u32>;
@group(0) @binding(7) var borderTex: texture_2d<f32>;
@group(0) @binding(8) var wearMaskTex: texture_2d<f32>;
@group(0) @binding(9) var mBaseColor: texture_2d<f32>;
@group(0) @binding(10) var mRoughness: texture_2d<f32>;
@group(0) @binding(11) var mMetallic: texture_2d<f32>;
@group(0) @binding(12) var mAo: texture_2d<f32>;
// The second PBR set; the top material's maps when none is bound (then W.substrateSource is 0).
@group(0) @binding(13) var sBaseColor: texture_2d<f32>;
@group(0) @binding(14) var sRoughness: texture_2d<f32>;
@group(0) @binding(15) var sMetallic: texture_2d<f32>;
@group(0) @binding(16) var sAo: texture_2d<f32>;
@group(0) @binding(17) var outBaseColor: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(18) var outRoughness: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(19) var outMetallic: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(20) var outAo: texture_storage_2d<rgba8unorm, write>;
// Final macro height (r32float): groove, bevel and wear without the intact material relief.
@group(0) @binding(21) var macroTex: texture_2d<f32>;
// x: first chunk of this dispatch (row bands, wear.ts BAND_ROWS); y: rows per chunk; z: lookback rows above a chunk.
@group(0) @binding(22) var<uniform> bandOffset: vec4<u32>;

// bandM floor (MIN_BAND_M in wear.ts).
override MIN_BAND_M: f32;
// Height AO on macroTex instead of heightTex: the material ships a real AO map (R33).
override AO_ON_MACRO: bool;

// Height AO strength: a sharp 4 mm groove with a 3 mm bevel comes out near 0.5 on its floor, as v0.1-A's 1 − 0.5·prof.
const AO_K = 0.7;
const PI = 3.14159265;

const S_SUBSTRATE = 0x7feb352du;
const S_RUNOFF = 0x846ca68bu;

fn rgb2hsv(c: vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 0.0) {
    if (mx == c.r) {
      h = (c.g - c.b) / d;
    } else if (mx == c.g) {
      h = 2.0 + (c.b - c.r) / d;
    } else {
      h = 4.0 + (c.r - c.g) / d;
    }
    h = fract(h / 6.0);
  }
  return vec3<f32>(h, select(0.0, d / mx, mx > 0.0), mx);
}

fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
  let k = abs(fract(vec3<f32>(c.x) + vec3<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3<f32>(1.0), clamp(k - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}

// Bilinear height at a continuous output-px position (texel centres at i + 0.5), clamped to the texture.
fn heightAt(src: texture_2d<f32>, p: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(src)) - 1;
  let q = p - 0.5;
  let i = vec2<i32>(floor(q));
  let f = q - floor(q);
  let lo = clamp(i, vec2<i32>(0), size);
  let hi = clamp(i + 1, vec2<i32>(0), size);
  let a = textureLoad(src, lo, 0).r;
  let b = textureLoad(src, vec2<i32>(hi.x, lo.y), 0).r;
  let c = textureLoad(src, vec2<i32>(lo.x, hi.y), 0).r;
  let d = textureLoad(src, hi, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn heightAo(src: texture_2d<f32>, c: vec2<i32>) -> f32 {
  let h = textureLoad(src, c, 0).r;
  let pxPerM = P.ppmRef * P.refScale;
  let centre = vec2<f32>(c) + 0.5;
  var radii = array<f32, 3>(0.005, 0.02, 0.06);
  var occ = 0.0;
  for (var k = 0u; k < 3u; k++) {
    let rPx = radii[k] * pxPerM;
    var sum = 0.0;
    for (var t = 0u; t < 8u; t++) {
      // Each radius turns its 8 taps by a third of their spacing so they do not line up.
      let a = (f32(t) + f32(k) / 3.0) * (PI / 4.0);
      sum += heightAt(src, centre + rPx * vec2<f32>(cos(a), sin(a)));
    }
    occ += max(0.0, sum / 8.0 - h) / radii[k];
  }
  return 1.0 - clamp(AO_K * occ, 0.0, 1.0);
}

fn readRough(t: texture_2d<f32>, uv: vec2<f32>, gloss: bool) -> f32 {
  let v = textureSampleLevel(t, samp, uv, 0.0).r;
  return select(v, 1.0 - v, gloss);
}

fn shade(c: vec2<i32>, id: u32, lossR: f32, lastLoss: i32) {
  let px = (vec2<f32>(c) + 0.5) / P.refScale;
  // The groove, and the groove floor inside a rect (R31).
  let groove = id == 0u || lossR < 0.0;
  var m: vec2<f32>;
  if (id == 0u) {
    // Groove / empty: global material coordinates (y up from the atlas bottom), as compose.wgsl.
    m = vec2<f32>(px.x / P.ppmRef, (P.refHeightPx - px.y) / P.ppmRef);
  } else {
    let pl = rects[id - 1u];
    m = atlasPxToMaterialM(pl.rect, pl.originM, pl.rotate90, px, P.ppmRef);
  }
  let uv = materialUv(m, P.tileSizeM);
  var col = textureSampleLevel(mBaseColor, samp, uv, 0.0);
  var rough = readRough(mRoughness, uv, P.roughnessIsGloss != 0u);
  var metal = textureSampleLevel(mMetallic, samp, uv, 0.0).r;
  var aoMat = textureSampleLevel(mAo, samp, uv, 0.0).r;
  var aoH: f32;
  if (AO_ON_MACRO) {
    aoH = heightAo(macroTex, c);
  } else {
    aoH = heightAo(heightTex, c);
  }
  let tint = vec3<f32>(W.tintR, W.tintG, W.tintB);

  if (!groove) {
    let pl = rects[id - 1u];
    let r = pl.rect;
    let halfGroovePx = 0.5 * P.grooveWidthM * P.ppmRef;
    let local = wearLocalM(id, r, px, P.ppmRef, P.seed);

    if (W.enabled != 0u) {
      // Same thin-trim cap as wearLoss.wgsl; widthM 0 disables edge wear entirely, edge tone included (R30).
      let visibleMinM = max(min(r.z, r.w) / P.ppmRef - P.grooveWidthM, 0.0);
      let wEff = min(W.widthM, 0.33 * visibleMinM);
      if (wEff > 0.0) {
        var edge = 0.0;
        if (W.loses != 0u) {
          let wm = textureLoad(wearMaskTex, c, 0).r;
          if (wm > 0.0) {
            var sc: vec3<f32>;
            var sr: f32;
            var sm = metal;
            var sao = aoMat;
            if (W.substrateSource == 1u) {
              let suv = materialUv(m, W.substrateTileM);
              sc = textureSampleLevel(sBaseColor, samp, suv, 0.0).rgb;
              sr = readRough(sRoughness, suv, W.substrateGloss != 0u);
              sm = textureSampleLevel(sMetallic, samp, suv, 0.0).r;
              sao = textureSampleLevel(sAo, samp, suv, 0.0).r;
            } else {
              var hsv = rgb2hsv(col.rgb);
              hsv.x = fract(hsv.x + W.hueShift / 360.0);
              hsv.y = clamp(hsv.y * W.satMul, 0.0, 1.0);
              hsv.z = clamp(hsv.z * W.valMul, 0.0, 1.0);
              let grain = 0.9 + 0.2 * fbm(local / 0.004, 4u, P.seed ^ S_SUBSTRATE);
              sc = clamp(hsv2rgb(hsv) * grain, vec3<f32>(0.0), vec3<f32>(1.0));
              sr = clamp(rough + W.roughAdd, 0.0, 1.0);
            }
            col = vec4<f32>(mix(col.rgb, sc, wm), col.a);
            rough = mix(rough, sr, wm);
            metal = mix(metal, sm, wm);
            aoMat = mix(aoMat, sao, wm);
          }
          // Fracture band on both sides of the loss contour; 0 where there is no contour (border clamped at 4 · bandM).
          let b = textureLoad(borderTex, c, 0).r;
          edge = 1.0 - smoothstep(0.0, max(W.bandM, MIN_BAND_M), abs(b));
        }
        let bevelPx = P.bevelM * P.ppmRef;
        if (bevelPx > 0.0) {
          let ve = visibleEdgePx(r, px, halfGroovePx);
          edge = max(edge, grooveProfile(P.profile, clamp(ve / bevelPx, 0.0, 1.0)));
        }
        let tone = W.edgeTone * W.polish * edge;
        if (tone > 0.0) {
          var hsv = rgb2hsv(col.rgb);
          hsv.z = mix(hsv.z, 1.0, tone);
          col = vec4<f32>(hsv2rgb(hsv), col.a);
          rough = max(rough - 0.3 * tone, 0.0);
        }
      }
    }

    // Runoff from the visible top edge and from the losses above (never above its origin).
    let L = W.runoffLengthM;
    if (W.runoff > 0.0 && L > 0.0) {
      let dTop = max(px.y - (r.y + halfGroovePx), 0.0) / P.ppmRef;
      var reach = 1.0 - smoothstep(0.0, L, dTop);
      if (lastLoss >= 0) {
        let dLoss = f32(c.y - lastLoss) / (P.ppmRef * P.refScale);
        reach = max(reach, 1.0 - smoothstep(0.0, L, dLoss));
      }
      if (reach > 0.0) {
        let streak = fbm(vec2<f32>(local.x / 0.01, local.y / L), 4u, P.seed ^ S_RUNOFF);
        col = vec4<f32>(mix(col.rgb, tint * col.rgb, W.runoff * reach * streak), col.a);
      }
    }
  }

  if (W.cavity > 0.0) {
    let k = W.cavity * (1.0 - aoMat * aoH);
    col = vec4<f32>(mix(col.rgb, tint * col.rgb, k), col.a);
    rough = min(rough + 0.1 * k, 1.0);
  }
  let ao = aoMat * aoH;
  textureStore(outBaseColor, c, col);
  textureStore(outRoughness, c, vec4<f32>(rough, rough, rough, 1.0));
  textureStore(outMetallic, c, vec4<f32>(metal, metal, metal, 1.0));
  textureStore(outAo, c, vec4<f32>(ao, ao, ao, 1.0));
}

// gid.x: column, gid.y + bandOffset.x: chunk of bandOffset.y rows.
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let rows = u32(P.outSize.y);
  let chunkRows = bandOffset.y;
  let start = (gid.y + bandOffset.x) * chunkRows;
  if (f32(gid.x) >= P.outSize.x || start >= rows) { return; }
  let end = min(start + chunkRows, rows);
  let x = i32(gid.x);
  // Losses tint only with wear, a family that loses material, and runoff.
  let lossOrigins = W.enabled != 0u && W.loses != 0u && W.runoff > 0.0 && W.runoffLengthM > 0.0;
  var curId = 0xffffffffu;
  // Row of the latest lost pixel above, in the current rect; -1: none.
  var lastLoss = -1;
  var y = start;
  if (lossOrigins) { y = start - min(start, bandOffset.z); }
  for (; y < end; y++) {
    let c = vec2<i32>(x, i32(y));
    let id = textureLoad(rectIdTex, c, 0).r;
    if (id != curId) {
      curId = id;
      lastLoss = -1;
    }
    var lossR = 0.0;
    if (W.enabled != 0u && id != 0u) { lossR = unpack2x16float(textureLoad(lossTex, c, 0).r).x; }
    if (lossOrigins && lossR > 0.5) { lastLoss = i32(y); }
    if (y >= start) { shade(c, id, lossR, lastLoss); }
  }
}
