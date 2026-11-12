// Pass 1: one quad per rect, shrunk by half the groove width on every side.
// Writes id = rect index + 1; the clear value 0 marks groove / empty pixels.

struct Rect {
  rect: vec4<f32>,         // x, y, w, h in reference px, top-left origin
  originM: vec2<f32>,
  rotate90: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) id: u32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let r = rects[ii].rect * P.refScale;
  let half = 0.5 * P.grooveWidthM * P.ppmRef * P.refScale;
  let x0 = r.x + half;
  let y0 = r.y + half;
  // Clamp so a rect narrower than the groove collapses instead of inverting.
  let x1 = max(r.x + r.z - half, x0);
  let y1 = max(r.y + r.w - half, y0);
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  let px = vec2<f32>(mix(x0, x1, c.x), mix(y0, y1, c.y));
  var out: VOut;
  out.pos = vec4<f32>(px.x / P.outSize.x * 2.0 - 1.0, 1.0 - px.y / P.outSize.y * 2.0, 0.0, 1.0);
  out.id = ii + 1u;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) u32 {
  return in.id;
}
