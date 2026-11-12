export { createRng } from './rng';
export type { Rng } from './rng';
export { DEFAULT_GROOVE, pxPerMetre, rectSizeM, validateLayout, makeRect } from './layout';
export type {
  UseOn, HotspotRect, GrooveProfile, GrooveSettings, HotspotLayout, LayoutIssue,
} from './layout';
export { CONTINUOUS, snapToPeriod, checkProportions } from './period';
export type { MaterialPeriod, ProportionIssue } from './period';
export { PRESET_IDS, presetLayout } from './presets';
export type { PresetId } from './presets';
export { autoLayout } from './autoLayout';
export type { AutoTarget, AutoLayoutOptions } from './autoLayout';
export { placeMaterial, atlasPxToMaterialM } from './placement';
export type { RectPlacement, PlacementOptions } from './placement';
export {
  classifyMapFile, materialNameFromFiles, sanitizeMaterialName, resolveMaterialName, chooseMaps, MAP_DEFAULTS,
} from './material';
export type { MapKind, MapMatch, MaterialSettings } from './material';
export {
  createDefaultDoc, serializeDoc, parseDoc, toStack, resolveLayout, composeInputsFromDoc, updateNodeParams,
  DocParseError,
} from './document';
export type { ComposeInputs, NodeType, NodeParams, DocNode, DocEdge, ProjectDoc, StackEntry } from './document';
export { toHotspotJson, parseHotspotJson } from './export/hotspotJson';
export { toAnvilTable } from './export/anvilTable';
export { packMaps } from './export/packing';
export type { ExportPreset, MapPixels, PackedFile } from './export/packing';
export { encodePngRgba8 } from './export/png';
