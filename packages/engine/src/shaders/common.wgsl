// Shared prelude, prepended to every module with withCommon(). The only
// declaration of Params; its byte layout is packed by packParams (params.ts).

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
    sum += amp * valueNoise(q, seed + o * 101u);
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
  d1: f32,          // distance to the nearest feature point, in stretched space (cell units)
  d2: f32,          // distance to the second nearest
}

// Worley 3x3 with hash jitter. anisotropy > 1 stretches cells along +X (distances are measured in the stretched space).
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
