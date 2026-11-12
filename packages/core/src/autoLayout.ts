import { DEFAULT_GROOVE, makeRect } from './layout';
import type { HotspotLayout, HotspotRect } from './layout';
import type { MaterialPeriod } from './period';
import { createRng } from './rng';
import type { Rng } from './rng';

export type AutoTarget = 'walls' | 'floors' | 'trims' | 'mixed';

export interface AutoLayoutOptions {
  target: AutoTarget;
  widthPx: number;
  worldWidthM: number;
  /** Defaults to widthPx. */
  heightPx?: number;
  period: MaterialPeriod;
  seed: number;
  /** Defaults to 0.1. */
  minSizeM?: number;
  /** Defaults to 48. */
  maxRects?: number;
}

/** Grid step on axes without a hard period constraint. */
const FREE_UNIT_M = 0.01;
const TRIM_MIN_M = 0.06;
const TRIM_MAX_M = 0.3;

/** Region in integer grid units, measured from the atlas bottom-left. */
interface Region { x: number; y: number; nx: number; ny: number }
interface Cell extends Region { tileU: boolean }

interface Axis {
  unitM: number;
  /** Whole units that fit the region on this axis. */
  count: number;
  /** True when the region spans the full atlas on this axis. */
  full: boolean;
  atlasPx: number;
  ppm: number;
  minUnits: number;
}

function makeAxis(periodM: number | null, cutAllowed: boolean, atlasPx: number, ppm: number, minSizeM: number): Axis {
  const strict = periodM !== null && !cutAllowed;
  const unitM = periodM !== null ? periodM : FREE_UNIT_M;
  const atlasM = atlasPx / ppm;
  const count = Math.floor(atlasM / unitM + 1e-9);
  // A cut-allowed axis may use any grid; a strict axis must keep whole periods.
  const unit = strict ? unitM : FREE_UNIT_M;
  const n = strict ? count : Math.floor(atlasM / unit + 1e-9);
  return {
    unitM: unit,
    count: n,
    full: !strict || Math.abs(n * unit - atlasM) < 1e-9,
    atlasPx,
    ppm,
    minUnits: Math.max(1, Math.ceil(minSizeM / unit - 1e-9)),
  };
}

/** Pixel offset of a grid edge, from the cumulative metre position so shared edges coincide. */
function edgePx(a: Axis, units: number): number {
  if (units === a.count && a.full) return a.atlasPx;
  return Math.round(units * a.unitM * a.ppm);
}

function cutRegion(region: Region, axisX: boolean, at: number): [Region, Region] {
  return axisX
    ? [{ ...region, nx: at }, { ...region, x: region.x + at, nx: region.nx - at }]
    : [{ ...region, ny: at }, { ...region, y: region.y + at, ny: region.ny - at }];
}

class Partitioner {
  cells: Cell[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly target: AutoTarget,
    private readonly ax: Axis,
    private readonly ay: Axis,
  ) {}

  split(region: Region, budget: number): void {
    const { ax, ay, rng } = this;
    const canX = region.nx >= 2 * ax.minUnits;
    const canY = region.ny >= 2 * ay.minUnits;
    if (budget <= 1 || (!canX && !canY)) {
      this.cells.push({ ...region, tileU: false });
      return;
    }
    let cutX: boolean;
    if (canX && canY) {
      const longerX = region.nx * ax.unitM >= region.ny * ay.unitM;
      // Walls favour vertical cuts (tall rects); floors mix; others follow the longer side.
      const pX = this.target === 'walls' ? 0.65 : this.target === 'floors' ? 0.5 : longerX ? 0.7 : 0.3;
      cutX = rng.next() < pX;
    } else {
      cutX = canX;
    }
    const axis = cutX ? ax : ay;
    const n = cutX ? region.nx : region.ny;
    const frac = 0.25 + rng.next() * 0.5;
    const at = Math.min(n - axis.minUnits, Math.max(axis.minUnits, Math.round(frac * n)));
    const [a, b] = cutRegion(region, cutX, at);
    const areaA = a.nx * a.ny;
    const budgetA = Math.min(budget - 1, Math.max(1, Math.round((budget * areaA) / (areaA + b.nx * b.ny))));
    this.split(a, budgetA);
    this.split(b, budget - budgetA);
  }
}

export function autoLayout(o: AutoLayoutOptions): HotspotLayout {
  const heightPx = o.heightPx ?? o.widthPx;
  const minSizeM = o.minSizeM ?? 0.1;
  const maxRects = o.maxRects ?? 48;
  const rng = createRng(o.seed);
  const ppm = o.widthPx / o.worldWidthM;
  const ax = makeAxis(o.period.x, o.period.cutAllowedX, o.widthPx, ppm, minSizeM);
  const ay = makeAxis(o.period.y, o.period.cutAllowedY, heightPx, ppm, minSizeM);
  const part = new Partitioner(rng, o.target, ax, ay);
  const whole: Region = { x: 0, y: 0, nx: ax.count, ny: ay.count };

  if (o.target === 'trims') {
    const cap = Math.max(1, Math.floor(maxRects * 0.6));
    const lo = Math.max(1, Math.ceil(TRIM_MIN_M / ay.unitM - 1e-9));
    const hi = Math.max(lo, Math.floor(TRIM_MAX_M / ay.unitM + 1e-9));
    let used = 0;
    let bands = 0;
    // Full-width bands stacked from the bottom, using at most half the height.
    while (bands < cap && used + lo <= Math.floor(ay.count / 2)) {
      const h = Math.min(rng.int(lo, hi), Math.floor(ay.count / 2) - used);
      part.cells.push({ x: 0, y: used, nx: ax.count, ny: h, tileU: true });
      used += h;
      bands++;
    }
    if (used < ay.count) {
      part.split({ x: 0, y: used, nx: ax.count, ny: ay.count - used }, Math.max(1, Math.min(maxRects - bands, bands - 1)));
    }
  } else {
    const target = rng.int(Math.min(10, maxRects), Math.min(28, maxRects));
    part.split(whole, target);
  }

  const useOn = o.target === 'walls' || o.target === 'floors' ? o.target : 'any';
  const rects: HotspotRect[] = part.cells.map((c, i) => {
    const x = edgePx(ax, c.x);
    const w = edgePx(ax, c.x + c.nx) - x;
    const bottom = edgePx(ay, c.y);
    const top = edgePx(ay, c.y + c.ny);
    return makeRect({
      id: `r${i + 1}`,
      x,
      y: heightPx - top,
      w,
      h: top - bottom,
      // Tiling needs the full atlas width; a partial-width band cannot repeat.
      tileU: c.tileU && w === o.widthPx,
      useOn,
      group: c.tileU ? (w === o.widthPx ? 'trim' : 'band') : '',
    });
  });

  return {
    version: 1,
    widthPx: o.widthPx,
    heightPx,
    worldWidthM: o.worldWidthM,
    rects,
    groove: { ...DEFAULT_GROOVE },
  };
}
