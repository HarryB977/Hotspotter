// DX -> GL normal map conversion: G' = 1 - G.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(src);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let c = textureLoad(src, vec2<i32>(gid.xy), 0);
  textureStore(dst, vec2<i32>(gid.xy), vec4<f32>(c.r, 1.0 - c.g, c.b, c.a));
}
