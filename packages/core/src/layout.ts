export type UseOn = 'walls' | 'floors' | 'ceilings' | 'any';

/** Coordinates in px at reference resolution, top-left origin. */
export interface HotspotRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  allowRotation: boolean;
  allowMirrorX: boolean;
  allowMirrorY: boolean;
  tileU: boolean;
  tileV: boolean;
  useOn: UseOn;
  inset: number;
  group: string;
}

export type GrooveProfile = 'bevel' | 'round' | 'step' | 'none';

export interface GrooveSettings {
  /** Flat groove floor, centred on the edge shared by two rects. */
  widthM: number;
  /** Bevel width inside each rect, measured from the floor edge. */
  bevelM: number;
  depthM: number;
  profile: GrooveProfile;
}

export interface HotspotLayout {
  version: 1;
  widthPx: number;
  heightPx: number;
  worldWidthM: number;
  rects: HotspotRect[];
  groove: GrooveSettings;
}

export const DEFAULT_GROOVE: GrooveSettings = { widthM: 0.006, bevelM: 0.003, depthM: 0.004, profile: 'bevel' };

const MIN_RECT_PX = 4;

export function pxPerMetre(l: HotspotLayout): number {
  return l.widthPx / l.worldWidthM;
}

export function rectSizeM(l: HotspotLayout, r: HotspotRect): { w: number; h: number } {
  const ppm = pxPerMetre(l);
  return { w: r.w / ppm, h: r.h / ppm };
}

export type LayoutIssue = {
  kind: 'overlap' | 'outOfBounds' | 'tileNotFullSpan' | 'tooSmall';
  rectIds: string[];
};

export function validateLayout(l: HotspotLayout): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const { rects } = l;

  for (const r of rects) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > l.widthPx || r.y + r.h > l.heightPx) {
      issues.push({ kind: 'outOfBounds', rectIds: [r.id] });
    }
    if ((r.tileU && r.w < l.widthPx) || (r.tileV && r.h < l.heightPx)) {
      issues.push({ kind: 'tileNotFullSpan', rectIds: [r.id] });
    }
    if (r.w < MIN_RECT_PX || r.h < MIN_RECT_PX) {
      issues.push({ kind: 'tooSmall', rectIds: [r.id] });
    }
  }

  // Rects sharing only an edge do not overlap (strict inequalities).
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        issues.push({ kind: 'overlap', rectIds: [a.id, b.id] });
      }
    }
  }

  return issues;
}

export function makeRect(
  partial: Pick<HotspotRect, 'id' | 'x' | 'y' | 'w' | 'h'> & Partial<HotspotRect>,
): HotspotRect {
  return {
    allowRotation: false,
    allowMirrorX: false,
    allowMirrorY: false,
    tileU: false,
    tileV: false,
    useOn: 'any',
    inset: 0,
    group: '',
    ...partial,
  };
}
