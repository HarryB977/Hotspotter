// Height (metres) normalized by heightRangeM into an 8-bit grey map.

@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> rangeM: vec2<f32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(heightTex);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let h = textureLoad(heightTex, vec2<i32>(gid.xy), 0).r;
  let span = rangeM.y - rangeM.x;
  let v = select(0.5, clamp((h - rangeM.x) / span, 0.0, 1.0), span > 0.0);
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(v, v, v, 1.0));
}
