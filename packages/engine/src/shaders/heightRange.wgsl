// Min/max reduction of the r32float height map. Floats are mapped to u32 keys
// whose unsigned order matches float order, so atomicMin/atomicMax work.

@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> range: array<atomic<u32>, 2>;

var<workgroup> wMin: atomic<u32>;
var<workgroup> wMax: atomic<u32>;

fn orderedKey(f: f32) -> u32 {
  let b = bitcast<u32>(f);
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    atomicStore(&wMin, 0xffffffffu);
    atomicStore(&wMax, 0u);
  }
  workgroupBarrier();
  let size = textureDimensions(heightTex);
  if (gid.x < size.x && gid.y < size.y) {
    let k = orderedKey(textureLoad(heightTex, vec2<i32>(gid.xy), 0).r);
    atomicMin(&wMin, k);
    atomicMax(&wMax, k);
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicMin(&range[0], atomicLoad(&wMin));
    atomicMax(&range[1], atomicLoad(&wMax));
  }
}
