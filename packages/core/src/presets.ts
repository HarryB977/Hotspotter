import { DEFAULT_GROOVE, makeRect } from './layout';
import type { HotspotLayout, HotspotRect } from './layout';

export type PresetId = 'walls' | 'floors' | 'trims' | 'frames' | 'generic' | 'mixed';

export const PRESET_IDS: readonly PresetId[] = ['walls', 'floors', 'trims', 'frames', 'generic', 'mixed'];

// Presets are authored on an 8 m x 8 m square atlas in whole centimetres, as
// guillotine trees: every split is a full straight cut, which is what Anvil's
// hotspot detection expects. Pixel edges come from the cumulative cm position
// of each cut, so shared edges round identically and the result has no gaps.
const ATLAS_CM = 800;

type Props = Partial<Omit<HotspotRect, 'id' | 'x' | 'y' | 'w' | 'h'>>;
type Kid = [sizeCm: number, node: Node];
type Node =
  | { kind: 'leaf'; props: Props }
  | { kind: 'split'; axis: 'x' | 'y'; kids: Kid[] };

const leaf = (props: Props = {}): Node => ({ kind: 'leaf', props });
/** Children stacked top to bottom; sizes are heights. */
const stack = (...kids: Kid[]): Node => ({ kind: 'split', axis: 'y', kids });
/** Children side by side; sizes are widths. */
const row = (...kids: Kid[]): Node => ({ kind: 'split', axis: 'x', kids });
/** A band of the given height cut into leaves of the given widths. */
const band = (heightCm: number, widths: number[], props: Props = {}): Kid => [
  heightCm,
  row(...widths.map((w): Kid => [w, leaf(props)])),
];

const WALL: Props = { useOn: 'walls', group: 'wall' };
const HALF: Props = { useOn: 'walls', group: 'half' };
const WALL_TILE: Props = { useOn: 'walls', group: 'tile', tileU: true };
const PLANK: Props = { useOn: 'floors', group: 'plank', tileU: true };
const SLAB: Props = { useOn: 'floors', group: 'slab', allowRotation: true };
const TRIM: Props = { group: 'trim', tileU: true };
const JAMB: Props = { useOn: 'walls', group: 'jamb' };
const LINTEL: Props = { useOn: 'walls', group: 'lintel' };
const SILL: Props = { useOn: 'walls', group: 'sill' };
const PANEL: Props = { group: 'panel', allowRotation: true };

const TRIM_CYCLE = [30, 24, 20, 16, 12, 10, 8, 6];

function trimBands(): Kid[] {
  const heights: number[] = [];
  let total = 0;
  for (let i = 0; total < ATLAS_CM; i++) {
    const h = TRIM_CYCLE[i % TRIM_CYCLE.length];
    heights.push(Math.min(h, ATLAS_CM - total));
    total += h;
  }
  // A truncated last strip may fall under 6 cm; fold it into the previous one.
  if (heights.length > 1 && heights[heights.length - 1] < 6) {
    const last = heights.pop() as number;
    heights[heights.length - 1] += last;
  }
  return heights.map((h) => band(h, [ATLAS_CM], TRIM));
}

const TREES: Record<PresetId, Node> = {
  walls: stack(
    band(260, [320, 200, 120, 80, 40, 40], WALL),
    band(260, [280, 200, 160, 100, 60], WALL),
    band(120, [200, 200, 160, 120, 120], HALF),
    band(80, [800], WALL_TILE),
    band(80, [40, 40, 80, 80, 160, 200, 200], WALL),
  ),
  floors: stack(
    band(16, [800], PLANK),
    band(16, [800], PLANK),
    band(24, [800], PLANK),
    band(24, [800], PLANK),
    band(240, [240, 240, 120, 100, 100], SLAB),
    band(160, [160, 160, 160, 80, 80, 80, 80], SLAB),
    band(120, [120, 120, 120, 120, 120, 100, 100], SLAB),
    band(100, [100, 100, 100, 100, 200, 200], SLAB),
    band(60, [30, 30, 60, 60, 120, 200, 300], SLAB),
    band(40, [40, 40, 80, 160, 240, 240], SLAB),
  ),
  trims: stack(...trimBands()),
  frames: stack(
    band(220, [20, 20, 30, 30, 40, 40, 60, 60, 100, 200, 200], JAMB),
    band(20, [100, 100, 150, 150, 300], LINTEL),
    band(30, [120, 120, 160, 200, 200], LINTEL),
    band(40, [200, 200, 200, 200], LINTEL),
    band(10, [100, 100, 200, 200, 200], SILL),
    band(15, [150, 150, 250, 250], SILL),
    band(240, [25, 25, 50, 50, 100, 150, 200, 200], JAMB),
    band(225, [40, 40, 60, 60, 100, 100, 200, 200], JAMB),
  ),
  generic: stack(
    [400, row(
      [400, leaf()],
      [200, stack([200, leaf()], [200, leaf()])],
      [200, stack([100, leaf()], [100, leaf()], [200, leaf()])],
    )],
    band(200, [400, 200, 100, 100]),
    band(100, [100, 100, 100, 100, 200, 200]),
    band(60, [60, 60, 60, 60, 120, 120, 160, 160]),
    band(28, [28, 28, 56, 56, 112, 120, 400]),
    band(12, [12, 12, 24, 24, 48, 96, 200, 384]),
  ),
  mixed: stack(
    band(260, [320, 200, 160, 120], WALL),
    band(120, [200, 200, 200, 200], HALF),
    band(80, [800], WALL_TILE),
    band(180, [180, 180, 180, 180, 80], SLAB),
    band(20, [800], TRIM),
    band(16, [800], TRIM),
    band(12, [800], TRIM),
    band(10, [800], TRIM),
    band(50, [100, 100, 200, 200, 200], LINTEL),
    band(52, [52, 52, 104, 104, 208, 280], PANEL),
  ),
};

function build(tree: Node, widthPx: number): HotspotRect[] {
  const rects: HotspotRect[] = [];
  const px = (cm: number) => Math.round((cm * widthPx) / ATLAS_CM);

  const walk = (node: Node, x: number, y: number, w: number, h: number): void => {
    if (node.kind === 'leaf') {
      rects.push(makeRect({
        id: `r${rects.length + 1}`,
        x: px(x), y: px(y), w: px(x + w) - px(x), h: px(y + h) - px(y),
        ...node.props,
      }));
      return;
    }
    const extent = node.axis === 'x' ? w : h;
    const sum = node.kids.reduce((s, [size]) => s + size, 0);
    if (sum !== extent) throw new Error(`preset split sums to ${sum} cm, expected ${extent} cm`);
    let offset = 0;
    for (const [size, child] of node.kids) {
      if (node.axis === 'x') walk(child, x + offset, y, size, h);
      else walk(child, x, y + offset, w, size);
      offset += size;
    }
  };

  walk(tree, 0, 0, ATLAS_CM, ATLAS_CM);
  return rects;
}

/**
 * Square preset atlas. Proportions are fixed fractions of the atlas (designed
 * for 8 m); `worldWidthM` only sets the physical scale the atlas maps to.
 */
export function presetLayout(id: PresetId, widthPx = 4096, worldWidthM = 8): HotspotLayout {
  return {
    version: 1,
    widthPx,
    heightPx: widthPx,
    worldWidthM,
    rects: build(TREES[id], widthPx),
    groove: { ...DEFAULT_GROOVE },
  };
}
