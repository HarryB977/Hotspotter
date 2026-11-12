// Shared prelude, prepended to every module with withCommon(). The only
// declaration of Params, Wear and Rect; their byte layouts are packed by
// packParams, packWear and rectsBuffer (params.ts, compose.ts).

struct Params {
  outSize: vec2<f32>,      // output texture size, px
  refScale: f32,           // output px per reference (layout) px
  ppmRef: f32,             // reference px per metre
  tileSizeM: vec2<f32>,
  heightScaleM: f32,
  grooveWidthM: f32,       // flat groove floor, centred on the shared edge
  grooveDepthM: f32,
  profile: u32,            // 0 bevel, 1 round, 2 step, 3 none
  roughnessIsGloss: u32,
  refHeightPx: f32,        // layout height in reference px
  sobelMacro: u32,         // 1: Sobel on the macro height (matNormal.a), the material has a normal map
  bevelM: f32,             // bevel width inside each rect, metres
  seed: u32,               // wear seed
  pad0: u32,
}

// Wear and dirt uniforms (R17), packed by packWear (params.ts). Scalars only, so offsets are index * 4.
struct Wear {
  enabled: u32,            // 0: no wear, the wear passes are skipped
  intensity: f32,
  widthM: f32,
  minEdgeM: f32,
  sizeM: f32,
  depthM: f32,
  bandM: f32,
  microM: f32,
  pieceBias: f32,
  edgeTone: f32,
  maskStrength: f32,
  maskEnabled: u32,        // 1: a mask texture is bound and enabled
  maskInvert: u32,
  hasPieces: u32,          // 1: the structure has joints (pieceId / jointDistM are meaningful)
  grainAxis: u32,          // material grain: 0 none, 1 x, 2 y
  cellMix: f32,            // family shape (WEAR_FAMILIES)
  anisotropy: f32,
  steps: u32,
  loses: u32,
  polish: f32,
  cavity: f32,             // dirt
  runoff: f32,
  runoffLengthM: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  family: u32,             // FAMILY_CODE (params.ts)
  pad1: u32,
  pad2: u32,
  pad3: u32,
  pad4: u32,
  pad5: u32,
}

struct Rect {
  rect: vec4<f32>,         // x, y, w, h in reference px, top-left origin
  originM: vec2<f32>,
  rotate90: u32,
  pad: u32,
}

// Distance in reference px from px to the visible edge of rect r, the edge shrunk by halfGroovePx (the groove floor
// edge). Negative outside it.
fn visibleEdgePx(r: vec4<f32>, px: vec2<f32>, halfGroovePx: f32) -> f32 {
  return min(
    min(px.x - (r.x + halfGroovePx), (r.x + r.z - halfGroovePx) - px.x),
    min(px.y - (r.y + halfGroovePx), (r.y + r.w - halfGroovePx) - px.y),
  );
}

// ---- Noise and hash utilities. Coordinates are world/atlas metres (or any float lattice); there is no wrap. ----

fn pcg3d(v_in: vec3<u32>) -> vec3<u32> {
  var v = v_in * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

// Hash of the integer lattice cell floor(p); returns [0,1). The floor goes through i32 so large coordinates do not
// lose precision in the hash itself.
fn hash31(p: vec3<f32>, seed: u32) -> f32 {
  let ip = bitcast<vec3<u32>>(vec3<i32>(floor(p)));
  let h = pcg3d(vec3<u32>(ip.x ^ (seed * 747796405u), ip.y + seed, ip.z ^ (seed * 2891336453u)));
  return f32(h.x >> 8u) * (1.0 / 16777216.0);
}

fn valueNoise(p: vec2<f32>, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash31(vec3<f32>(i, 0.0), seed);
  let b = hash31(vec3<f32>(i + vec2<f32>(1.0, 0.0), 0.0), seed);
  let c = hash31(vec3<f32>(i + vec2<f32>(0.0, 1.0), 0.0), seed);
  let d = hash31(vec3<f32>(i + vec2<f32>(1.0, 1.0), 0.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// fBm with lacunarity 2 and gain 0.5, normalised to [0,1). Each octave uses its own seed and a lattice offset.
fn fbm(p: vec2<f32>, octaves: u32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var q = p;
  for (var o = 0u; o < octaves; o++) {
    sum += amp * valueNoise(q, seed ^ (o * 0x9e3779b9u));
    norm += amp;
    amp *= 0.5;
    q = q * 2.0 + vec2<f32>(17.3, 9.1);
  }
  return sum / norm;
}

// Domain warp: displaces p by up to amountM in each axis.
fn warp(p: vec2<f32>, amountM: f32, seed: u32) -> vec2<f32> {
  let dx = valueNoise(p, seed ^ 0x9e3779b9u) - 0.5;
  let dy = valueNoise(p + vec2<f32>(31.7, 11.3), seed ^ 0x85ebca6bu) - 0.5;
  return p + 2.0 * amountM * vec2<f32>(dx, dy);
}

struct VoronoiHit {
  cell: vec2<i32>,  // lattice cell of the nearest feature point
  d1: f32,          // distance to the nearest feature point, in stretched cell units (x divided by anisotropy)
  d2: f32,          // distance to the second nearest, same units; inexact beyond the 3x3 neighbourhood
}

// Worley 3x3 with hash jitter. anisotropy > 1 stretches cells along +X; d1 and d2 are measured in the stretched
// space, in cell units, not in the units of p.
fn voronoi(p: vec2<f32>, anisotropy: f32, seed: u32) -> VoronoiHit {
  let q = vec2<f32>(p.x / max(anisotropy, 1e-3), p.y);
  let base = floor(q);
  var hit = VoronoiHit(vec2<i32>(0), 1e9, 1e9);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = base + vec2<f32>(f32(i), f32(j));
      let jitter = vec2<f32>(hash31(vec3<f32>(c, 1.0), seed), hash31(vec3<f32>(c, 2.0), seed));
      let d = length(c + jitter - q);
      if (d < hit.d1) {
        hit.d2 = hit.d1;
        hit.d1 = d;
        hit.cell = vec2<i32>(c);
      } else if (d < hit.d2) {
        hit.d2 = d;
      }
    }
  }
  return hit;
}
