// Wear loss pass: where the material breaks. Writes pack2x16float(loss, depth): loss = 1 where material is lost
// (0 otherwise) and depth = the target depth in metres (R29). Everything is sized in metres on rect-local coordinates, so the result does
// not depend on the output resolution. Groove pixels (rect id 0) get 0.

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;
@group(0) @binding(2) var rectIdTex: texture_2d<u32>;
@group(0) @binding(3) var pieceIdTex: texture_2d<u32>;
@group(0) @binding(4) var jointDistTex: texture_2d<f32>;
@group(0) @binding(5) var<uniform> W: Wear;
@group(0) @binding(6) var maskTex: texture_2d<f32>;
@group(0) @binding(7) var samp: sampler;
@group(0) @binding(8) var outLoss: texture_storage_2d<r32uint, write>;

// Independent seed streams per use, so no two noises share a lattice.
const S_WARP = 0x68e31da4u;
const S_CELL = 0xcc9e2d51u;
const S_CELLHASH = 0x85ebca77u;
const S_FBM = 0xc2b2ae3du;
const S_RIM = 0x27d4eb2fu;
const S_DEPTH = 0x165667b1u;
const S_PIECE = 0xd3a2646cu;

const FAMILY_DENT = 4u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (f32(gid.x) >= P.outSize.x || f32(gid.y) >= P.outSize.y) { return; }
  let c = vec2<i32>(gid.xy);
  let id = textureLoad(rectIdTex, c, 0).r;
  if (id == 0u || W.enabled == 0u) {
    textureStore(outLoss, c, vec4<u32>(0u));
    return;
  }
  let pl = rects[id - 1u];
  let r = pl.rect;
  let ppm = P.ppmRef;
  let px = (vec2<f32>(gid.xy) + 0.5) / P.refScale;

  // Groove floor (outside the visible, groove-shrunk rect): never worn (R31). lossR = -1 marks it as "don't care" for
  // the border pass (R32a); every reader treats lossR < 0 as 0.
  let ve = visibleEdgePx(r, pl.seams, px, 0.5 * P.grooveWidthM * ppm);
  if (ve < 0.0) {
    textureStore(outLoss, c, vec4<u32>(pack2x16float(vec2<f32>(-1.0, 0.0)), 0u, 0u, 0u));
    return;
  }

  // Distance to the visible edge and damage potential.
  let e = ve / ppm;
  // Thin-trim cap on the visible rect (the rect minus the groove floor).
  let wEff = min(W.widthM, 0.33 * visibleMinM(r, pl.seams, ppm, P.grooveWidthM));
  var pEdge = 0.0;
  if (wEff > 0.0) {
    pEdge = W.intensity * (1.0 - smoothstep(0.0, wEff, e));
  }

  // User mask over the full atlas UV: black removes damage, mid grey is neutral, white doubles it.
  var pMask = 1.0;
  if (W.maskEnabled != 0u) {
    var m = textureSampleLevel(maskTex, samp, (vec2<f32>(gid.xy) + 0.5) / P.outSize, 0.0).r;
    if (W.maskInvert != 0u) { m = 1.0 - m; }
    pMask = mix(1.0, 2.0 * m, W.maskStrength);
  }

  // Pieces: damage concentrates within sizeM of a joint, with a per-piece weight.
  let pid = textureLoad(pieceIdTex, c, 0).r;
  let j = textureLoad(jointDistTex, c, 0).r;
  let pieceTerm = (1.0 - smoothstep(0.0, W.sizeM, j)) * (0.5 + hash31(vec3<f32>(f32(pid), 0.0, 0.0), P.seed ^ S_PIECE));
  let pPiece = mix(1.0, pieceTerm, W.pieceBias * f32(W.hasPieces));

  let pDamage = clamp(pEdge * pMask * pPiece, 0.0, 1.0);

  // Rect-local metres plus the per-rect offset (common.wgsl).
  let local = wearLocalM(id, r, px, ppm, P.seed);
  // Noise coordinates in units of sizeM, domain-warped by 0.3 · sizeM.
  let q = warp(local / W.sizeM, 0.3, P.seed ^ S_WARP);

  // Grain along the material axis; a rotated rect swaps it. Voronoi stretches along its +X.
  // No grain axis: material X (decision 43).
  var axis = W.grainAxis;
  if (axis == 0u) { axis = 1u; }
  if (pl.rotate90 != 0u) { axis = 3u - axis; }
  var vq = q;
  if (axis == 2u) { vq = q.yx; }
  let cell = voronoi(vq, W.anisotropy, P.seed ^ S_CELL);
  // Hashing the piece id splits a cell that crosses a joint, so fractures follow piece outlines.
  let cellHash = hash31(vec3<f32>(vec2<f32>(cell.cell), f32(pid)), P.seed ^ S_CELLHASH);
  let fbmV = fbm(q, 5u, P.seed ^ S_FBM);
  let s = mix(fbmV, cellHash, W.cellMix);

  // Guaranteed rim of minEdgeM, capped at half the thin-trim width (R28), with an irregular inner contour.
  let rimM = min(W.minEdgeM, 0.5 * wEff);
  let rim = e < rimM * (1.0 + 0.6 * fbm(q * 2.0, 3u, P.seed ^ S_RIM));
  let lost = s < pDamage || rim;

  var lossR = 0.0;
  var depth = 0.0;
  if (W.loses != 0u) {
    lossR = select(0.0, 1.0, lost);
    var t = fbm(q * 2.0, 3u, P.seed ^ S_DEPTH);
    if (W.steps > 0u) {
      let n = f32(W.steps);
      t = (min(floor(t * n), n - 1.0) + 1.0) / n;
    }
    depth = W.depthM * (0.5 + 0.5 * t);
  } else if (W.family == FAMILY_DENT) {
    depth = W.depthM * pDamage * 0.5;
  }
  textureStore(outLoss, c, vec4<u32>(pack2x16float(vec2<f32>(lossR, depth)), 0u, 0u, 0u));
}
