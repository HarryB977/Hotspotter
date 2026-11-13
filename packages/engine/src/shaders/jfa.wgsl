// Border pass: signed distance in metres to the loss contour, by jump flooding (JFA). Negative inside the loss,
// clamped to ±J.clampM. Standalone module (no common prelude).
//
// Seeds are the midpoints between 4-neighbour pixels on opposite sides of the contour, in half-pixel units, so the
// distance is measured to the contour itself rather than to the nearest boundary pixel. Only pairs in the same rect
// where neither pixel is groove floor (lossR < 0, R32a) seed, so contours never leak across rects or the groove. A seed packs x | y << 16;
// half-pixel coordinates reach 2 · size, which fits 16 bits for any texture up to 32767 px.

struct Jfa {
  step: i32,
  // First row of this flood dispatch (row bands, wear.ts BAND_ROWS); 0 for the other passes.
  rowOffset: i32,
  metresPerPx: f32,
  clampM: f32,
}

@group(0) @binding(0) var<uniform> J: Jfa;
@group(0) @binding(1) var lossTex: texture_2d<u32>;
@group(0) @binding(2) var seedIn: texture_2d<u32>;
@group(0) @binding(3) var seedOut: texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var borderOut: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var rectIdTex: texture_2d<u32>;

const NONE = 0xffffffffu;

fn lossR(p: vec2<i32>) -> f32 {
  return unpack2x16float(textureLoad(lossTex, p, 0).r).x;
}

fn isLost(p: vec2<i32>) -> bool {
  return lossR(p) > 0.5;
}

fn inside(p: vec2<i32>, dims: vec2<i32>) -> bool {
  return all(p >= vec2<i32>(0)) && all(p < dims);
}

// Squared distance, in half pixels, from the centre of pixel p (2p + 1) to seed s.
fn dist2(p: vec2<i32>, s: u32) -> i32 {
  let d = 2 * p + 1 - vec2<i32>(i32(s & 0xffffu), i32(s >> 16u));
  return d.x * d.x + d.y * d.y;
}

@compute @workgroup_size(8, 8)
fn seed(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(lossTex));
  let p = vec2<i32>(gid.xy);
  if (!inside(p, dims)) { return; }
  let me = isLost(p);
  let id = textureLoad(rectIdTex, p, 0).r;
  let onFloor = lossR(p) < 0.0;
  var s = NONE;
  var dirs = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1));
  for (var k = 0; k < 4; k++) {
    let q = p + dirs[k];
    if (!onFloor && inside(q, dims) && lossR(q) >= 0.0 && textureLoad(rectIdTex, q, 0).r == id && isLost(q) != me) {
      // Midpoint of the two centres: (2p + 1 + 2q + 1) / 2 = p + q + 1.
      let m = vec2<u32>(p + q + 1);
      s = m.x | (m.y << 16u);
      break;
    }
  }
  textureStore(seedOut, p, vec4<u32>(s, 0u, 0u, 0u));
}

@compute @workgroup_size(8, 8)
fn flood(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(seedIn));
  let p = vec2<i32>(gid.xy) + vec2<i32>(0, J.rowOffset);
  if (!inside(p, dims)) { return; }
  var best = textureLoad(seedIn, p, 0).r;
  var bestD = select(dist2(p, best), 0x7fffffff, best == NONE);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = p + vec2<i32>(i, j) * J.step;
      if ((i == 0 && j == 0) || !inside(q, dims)) { continue; }
      let s = textureLoad(seedIn, q, 0).r;
      if (s == NONE) { continue; }
      let d = dist2(p, s);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  textureStore(seedOut, p, vec4<u32>(best, 0u, 0u, 0u));
}

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(seedIn));
  let p = vec2<i32>(gid.xy);
  if (!inside(p, dims)) { return; }
  let s = textureLoad(seedIn, p, 0).r;
  // No seed within range: the clamp value.
  var m = J.clampM;
  if (s != NONE) {
    m = min(0.5 * sqrt(f32(dist2(p, s))) * J.metresPerPx, J.clampM);
  }
  textureStore(borderOut, p, vec4<f32>(select(m, -m, isLost(p)), 0.0, 0.0, 0.0));
}
