export { createRng } from './rng';
export type { Rng } from './rng';
export { DEFAULT_GROOVE, pxPerMetre, rectSizeM, seamlessAxes, validateLayout, makeRect } from './layout';
export type {
  UseOn, HotspotRect, GrooveProfile, GrooveSettings, HotspotLayout, LayoutIssue,
} from './layout';
export { CONTINUOUS, snapToPeriod, checkProportions } from './period';
export type { MaterialPeriod, ProportionIssue } from './period';
export {
  rectRotations, effectivePeriod, orientationUnit, OrientationUnitError, DEFAULT_ORIENTATION,
} from './orientation';
export type { OrientationRule, MaterialOrientation } from './orientation';
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
export type { HotspotJsonMeta } from './export/hotspotJson';
export { rectIdRgb, rectIdImage } from './export/rectId';
export { toAnvilTable } from './export/anvilTable';
export { engineLayout } from './export/engineLayout';
export { exportPreflight } from './export/preflight';
export type { ExportGpuLimits, ExportPreflight } from './export/preflight';
export { packMaps } from './export/packing';
export type { ExportPreset, MapPixels, PackedFile } from './export/packing';
export { encodePngRgba8 } from './export/png';
export { toGray, downsample, proposeMaterialType, analyzeStructure } from './structure/analyze';
export type { GrayImage, MaterialType, StructureResult } from './structure/analyze';
export { jointMask, segmentPieces, jointDistance } from './structure/pieces';
export { estimatePeriod } from './structure/period';
export { medianPieceSizeM } from './structure/pieceSize';
export type { PeriodEstimate } from './structure/period';
export { syntheticBrick, syntheticFbm, syntheticGrain } from './structure/synthetic';
export type { SyntheticBrickOptions } from './structure/synthetic';
export { WEAR_FAMILIES, DEFAULT_WEAR, DEFAULT_DIRT, proposeFamily, proposeWearSize } from './wear/params';
export type { WearFamily, FamilyShape, WearParams, DirtParams } from './wear/params';
export { CHECK_IDS, runChecks, deltaE76, jointMeanRgb, meanRgb } from './checks';
export type { CheckId, CheckStatus, CheckResult, EvalMaps, CheckContext } from './checks';
export { writeZip, readZip, crc32, MAX_UNPACKED_TOTAL, MAX_PROJECT_UPLOAD_BYTES } from './project/zip';
export { packProject, unpackProject, HspError } from './project/hsp';
export type { ProjectFile } from './project/zip';
export type { HspManifest } from './project/hsp';
export { matchHotspot } from './fit/match';
export type { FaceQuad, FaceUv, HotspotFit } from './fit/match';
export { buildShape, SHAPE_PARTS, STOREY_HEIGHT_M } from './fit/shapes';
export { faceSeed, fitFaces } from './fit/fitFaces';
export { faceBrickScale } from './fit/scale';
export type { TestShape, ShapeFace, ShapePart, Vec3 } from './fit/shapes';
