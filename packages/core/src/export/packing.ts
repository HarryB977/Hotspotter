export type ExportPreset = 'unity-urp' | 'unity-hdrp';

export interface MapPixels { width: number; height: number; data: Uint8Array /* RGBA8 */ }
export interface PackedFile { suffix: string; pixels: MapPixels }

type MapSet = Record<'baseColor' | 'normal' | 'height' | 'roughness' | 'metallic' | 'ao', MapPixels>;

/** Builds an RGBA8 image from a per-pixel function of the byte offset; grayscale inputs are read from R. */
function build(ref: MapPixels, fn: (i: number) => [number, number, number, number]): MapPixels {
  const data = new Uint8Array(ref.width * ref.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = fn(i);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: ref.width, height: ref.height, data };
}


/** Passthrough outputs (BaseColor, Normal, Height) alias the input buffers; callers must not mutate them. */
export function packMaps(preset: ExportPreset, maps: MapSet): PackedFile[] {
  const ref = maps.baseColor;
  for (const m of Object.values(maps)) {
    if (m.width !== ref.width || m.height !== ref.height) {
      throw new Error('packMaps: all input maps must have the same size');
    }
  }
  const metal = maps.metallic.data, rough = maps.roughness.data, ao = maps.ao.data;
  const common: PackedFile[] = [
    { suffix: '_BaseColor', pixels: maps.baseColor },
    { suffix: '_Normal', pixels: maps.normal },
  ];
  const height: PackedFile = { suffix: '_Height', pixels: maps.height };

  if (preset === 'unity-urp') {
    return [
      ...common,
      { suffix: '_MetallicSmoothness', pixels: build(ref, (i) => [metal[i], 0, 0, 255 - rough[i]]) },
      { suffix: '_Occlusion', pixels: build(ref, (i) => [ao[i], ao[i], ao[i], 255]) },
      height,
    ];
  }
  return [
    ...common,
    { suffix: '_MaskMap', pixels: build(ref, (i) => [metal[i], ao[i], 255, 255 - rough[i]]) },
    height,
  ];
}
