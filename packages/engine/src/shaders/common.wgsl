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
