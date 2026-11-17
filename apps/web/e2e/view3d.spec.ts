import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(BRICKS), 'samples/pbr/bricks wall 13 not present');

test.use({ viewport: { width: 1600, height: 900 } });

/** The 3D view shows textures of the store's current atlas and that holds still (analysis done, no recompose). */
async function settle(page: Page): Promise<void> {
  let stable = 0;
  let last = -1;
  await expect.poll(async () => {
    const r = await page.evaluate(() => {
      const hs = window.__hs!;
      const s = hs.store.getState();
      return { ok: s.analysisIdle && !!s.atlas && hs.view3d.shownCurrent(), gen: hs.view3dTextureGen };
    });
    stable = r.ok && r.gen === last ? stable + 1 : 0;
    last = r.gen;
    return stable;
  }, { timeout: 30_000, intervals: [300] }).toBeGreaterThanOrEqual(2);
  await settleFrames(page);
}

/** Waits until the 3D view stops drawing (it draws on demand). */
async function settleFrames(page: Page): Promise<number> {
  let last = -1;
  let frames = 0;
  await expect.poll(async () => {
    frames = await page.evaluate(() => window.__hs!.view3dFrames);
    const same = frames === last;
    last = frames;
    return same;
  }, { intervals: [150] }).toBe(true);
  return frames;
}

async function importBricks(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await settle(page);
}

async function shot(page: Page): Promise<string> {
  return (await page.getByTestId('view3d-canvas').screenshot()).toString('base64');
}

async function choose(page: Page, select: 'view3d-shape' | 'view3d-mode', option: string): Promise<void> {
  await page.getByTestId(select).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByTestId(select)).toHaveText(option);
}

interface Stats {
  mean: number; max: number; variance: number; accent: number; width: number; height: number;
  /** Pixels brighter than 200 (grey). */
  bright: number;
  /** Pixels that are not the background (#09090b): the shape. */
  shape: number;
}

/**
 * Grey mean, max and variance of a screenshot, how many pixels have the accent colour (#f59e0b), how many are bright
 * and how many show the shape.
 */
function stats(page: Page, b64: string): Promise<Stats> {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const n = bmp.width * bmp.height;
    let sum = 0, sq = 0, max = 0, accent = 0, bright = 0, shape = 0;
    for (let i = 0; i < n; i++) {
      const [r, gg, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
      const v = (r + gg + b) / 3;
      sum += v;
      sq += v * v;
      max = Math.max(max, r, gg, b);
      if (Math.abs(r - 245) < 25 && Math.abs(gg - 158) < 30 && b < 60) accent++;
      if (v > 200) bright++;
      if (Math.abs(r - 9) + Math.abs(gg - 9) + Math.abs(b - 11) > 6) shape++;
    }
    const mean = sum / n;
    return { mean, max, variance: sq / n - mean * mean, accent, bright, shape, width: bmp.width, height: bmp.height };
  }, b64);
}

/** Fraction of pixels whose colour differs by more than 24 levels on some channel. */
function changedFraction(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(async ([a, b]) => {
    const read = async (s: string) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const [pa, pb] = [await read(a), await read(b)];
    let changed = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])) > 24) changed++;
    }
    return changed / (pa.length / 4);
  }, [a, b]);
}

test('the lit cube shows the atlas: non-blank, and its front face has the colour of its rect', async ({ page }) => {
  await importBricks(page);
  await expect(page.getByTestId('view3d-shape')).toHaveText('Cubo');
  await expect(page.getByTestId('view3d-mode')).toHaveText('Iluminado');
  const b64 = await shot(page);
  const s = await stats(page, b64);
  expect(s.variance).toBeGreaterThan(200);

  const result = await page.evaluate(async (b64) => {
    const hs = window.__hs!;
    const front = hs.view3d.faces().find((f) => f.normal[2] === 1 && f.facing)!;
    // Atlas baseColor mean over the uv box the face samples.
    const st = hs.store.getState();
    const { data, width: W, height: H } = await hs.engine.readbackRgba8(st.gpu!, st.atlas!.maps.baseColor);
    const us = front.uv.map((p) => p[0]);
    const vs = front.uv.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...us) * W), x1 = Math.ceil(Math.max(...us) * W);
    const y0 = Math.floor((1 - Math.max(...vs)) * H), y1 = Math.ceil((1 - Math.min(...vs)) * H);
    const atlas = [0, 0, 0];
    let na = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        for (let c = 0; c < 3; c++) atlas[c] += data[(y * W + x) * 4 + c];
        na++;
      }
    }
    // Screen mean inside the face, shrunk toward its centre to stay off its edges.
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const cx = front.screen.reduce((a, p) => a + p[0], 0) / 4;
    const cy = front.screen.reduce((a, p) => a + p[1], 0) / 4;
    const quad = front.screen.map(([x, y]) => [cx + (x - cx) * 0.8, cy + (y - cy) * 0.8]);
    const inside = (x: number, y: number) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = quad[i];
        const [bx, by] = quad[(i + 1) % 4];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (cross !== 0) {
          if (sign !== 0 && Math.sign(cross) !== sign) return false;
          sign = Math.sign(cross);
        }
      }
      return true;
    };
    const screen = [0, 0, 0];
    let ns = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        for (let c = 0; c < 3; c++) screen[c] += px[(y * bmp.width + x) * 4 + c];
        ns++;
      }
    }
    return { atlas: atlas.map((v) => v / na), screen: screen.map((v) => v / ns), ns, rectId: front.rectId };
  }, b64);
  expect(result.ns).toBeGreaterThan(2000);
  for (let c = 0; c < 3; c++) expect(Math.abs(result.screen[c] - result.atlas[c])).toBeLessThanOrEqual(40);
});

test('switching the shape changes the picture and frees the old geometry', async ({ page }) => {
  await importBricks(page);
  const cube = await shot(page);
  /** GPU geometries of the mounted renderer and faces of the shape: one geometry per face is drawn in lit mode. */
  const geometry = () => page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuGeometries(), faces: window.__hs!.view3d.faces().length,
  }));
  const cubeGeometry = await geometry();
  expect(cubeGeometry).toEqual({ gpu: 6, faces: 6 });
  await choose(page, 'view3d-shape', 'Columna');
  await settleFrames(page);
  expect(await changedFraction(page, cube, await shot(page))).toBeGreaterThan(0.05);
  const column = await geometry();
  expect(column.gpu).toBe(column.faces);
  await choose(page, 'view3d-shape', 'Cubo');
  await settleFrames(page);
  expect(await geometry()).toEqual(cubeGeometry);
  for (const name of ['Pared con huecos', 'Pasillo', 'Escalera']) {
    await choose(page, 'view3d-shape', name);
    await settleFrames(page);
    expect((await stats(page, await shot(page))).variance).toBeGreaterThan(100);
  }
});

test('the Desgaste mode shows the wear mask unlit: dark with a few bright edges, unlike Height', async ({ page }) => {
  await importBricks(page);
  /** A wear mask on bricks: mostly black, with bright worn edges (some, but at most 5 % of the shape). */
  const wearLike = (s: Stats) => s.mean < 80 && s.max > 200 && s.bright >= 30 && s.bright / s.shape <= 0.05;
  await choose(page, 'view3d-mode', 'Desgaste');
  await settleFrames(page);
  expect(wearLike(await stats(page, await shot(page)))).toBe(true);
  // Height is dark around the shape too (on the cube its mean is below 80 as well), but its brick faces are bright:
  // it must not pass for the wear mask.
  await choose(page, 'view3d-mode', 'Height');
  await settleFrames(page);
  const height = await stats(page, await shot(page));
  expect(height.bright / height.shape).toBeGreaterThan(0.2);
  expect(wearLike(height)).toBe(false);
});

test('the Rectángulos mode outlines the rects and names the one under the pointer', async ({ page }) => {
  await importBricks(page);
  const lit = await stats(page, await shot(page));
  await choose(page, 'view3d-mode', 'Rectángulos');
  await settleFrames(page);
  const rects = await stats(page, await shot(page));
  expect(rects.accent).toBeGreaterThan(300);
  expect(lit.accent).toBeLessThan(rects.accent / 10);

  const front = await page.evaluate(() => window.__hs!.view3d.faces().find((f) => f.normal[2] === 1 && f.facing)!);
  const box = (await page.getByTestId('view3d-canvas').boundingBox())!;
  const cx = front.screen.reduce((a, p) => a + p[0], 0) / 4;
  const cy = front.screen.reduce((a, p) => a + p[1], 0) / 4;
  await page.mouse.move(box.x + cx, box.y + cy);
  await expect(page.getByTestId('view3d-tooltip')).toHaveText(`Rectángulo ${front.rectId}`);
});

test('a recomposition replaces the 3D texture set and frees the old one', async ({ page }) => {
  await importBricks(page);
  const before = await page.evaluate(() => ({
    gen: window.__hs!.view3dTextureGen, live: window.__hs!.view3d.liveTextures,
  }));
  await page.evaluate(() => window.__hs!.store.getState().updateNode('wear', { seed: 7 }));
  await expect.poll(() => page.evaluate(() => window.__hs!.view3dTextureGen)).toBeGreaterThan(before.gen);
  await settle(page);
  expect(await page.evaluate(() => window.__hs!.view3d.liveTextures)).toBe(before.live);
});

test('a remount in the middle of a readback leaks no textures or renderers', async ({ page }) => {
  await importBricks(page);
  const baseline = await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
  }));
  const midway = await page.evaluate(async () => {
    const hs = window.__hs!;
    const reads = hs.view3d.reads;
    const gen = hs.view3dTextureGen;
    hs.store.getState().updateNode('wear', { seed: 11 });
    // Remount as soon as the first read of the new atlas has started, before its set is built.
    const t0 = performance.now();
    while (hs.view3d.reads === reads && performance.now() - t0 < 10_000) await new Promise((ok) => setTimeout(ok, 0));
    hs.view3d.remount();
    return { started: hs.view3d.reads > reads, built: hs.view3dTextureGen !== gen };
  });
  expect(midway).toEqual({ started: true, built: false });
  await settle(page);
  const after = await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
    renderers: window.__hs!.view3d.renderers,
  }));
  expect(after).toEqual({ ...baseline, renderers: 1 });
});

test('a lost WebGL context comes back and is drawn again without any input', async ({ page }) => {
  await importBricks(page);
  const before = await stats(page, await shot(page));
  const frames = await page.evaluate(() => window.__hs!.view3dFrames);
  await page.evaluate(async () => {
    const cv = document.querySelector<HTMLCanvasElement>('[data-testid="view3d-canvas"]')!;
    const ext = cv.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    const lost = new Promise((ok) => cv.addEventListener('webglcontextlost', ok, { once: true }));
    ext.loseContext();
    await lost;
    // Chrome allows the restore only once the lost event's dispatch is over (it checks preventDefault after it).
    await new Promise((ok) => setTimeout(ok, 50));
    const restored = new Promise((ok) => cv.addEventListener('webglcontextrestored', ok, { once: true }));
    ext.restoreContext();
    await restored;
  });
  await expect.poll(() => page.evaluate(() => window.__hs!.view3dFrames)).toBeGreaterThan(frames);
  await settleFrames(page);
  const after = await stats(page, await shot(page));
  expect(after.variance).toBeGreaterThan(200);
  // The same picture: the textures and the room lighting are back, not just the background.
  expect(Math.abs(after.mean - before.mean)).toBeLessThan(before.mean * 0.1 + 2);
});

/** Turns a part's texture on or off through the "Partes" dropdown, and closes it. */
async function setPart(page: Page, name: string, on: boolean): Promise<void> {
  await page.getByTestId('view3d-parts').click();
  const menu = page.getByTestId('view3d-parts-menu');
  await menu.getByRole('checkbox', { name, exact: true }).setChecked(on);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

type FaceInfo = Awaited<ReturnType<NonNullable<Window['__hs']>['view3d']['faces']>>[number];

/** Mean RGB of a screenshot inside a face's screen quad, shrunk toward its centre by `shrink`, and the pixel count. */
function faceMean(page: Page, b64: string, screen: [number, number][], shrink = 0.6): Promise<{ rgb: number[]; n: number }> {
  return page.evaluate(async ([b64, screen, shrink]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const cx = screen.reduce((a, p) => a + p[0], 0) / 4;
    const cy = screen.reduce((a, p) => a + p[1], 0) / 4;
    const quad = screen.map(([x, y]) => [cx + (x - cx) * shrink, cy + (y - cy) * shrink]);
    const inside = (x: number, y: number) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = quad[i];
        const [bx, by] = quad[(i + 1) % 4];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (cross !== 0) {
          if (sign !== 0 && Math.sign(cross) !== sign) return false;
          sign = Math.sign(cross);
        }
      }
      return true;
    };
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        for (let c = 0; c < 3; c++) sum[c] += px[(y * bmp.width + x) * 4 + c];
        n++;
      }
    }
    return { rgb: sum.map((v) => v / n), n };
  }, [b64, screen, shrink] as const);
}

/** RGB of the screenshot pixel at a canvas point. */
function pixelAt(page: Page, b64: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(async ([b64, x, y]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    return [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
  }, [b64, x, y] as const);
}

const maxChannelDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const quadArea = (q: [number, number][]) =>
  Math.abs(q.reduce((a, [x, y], i) => a + x * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * y, 0)) / 2;

test('the wall with openings is open through its door and window', async ({ page }) => {
  await importBricks(page);
  await choose(page, 'view3d-shape', 'Pared con huecos');
  await settleFrames(page);
  const faces = await page.evaluate(() => window.__hs!.view3d.faces());
  const walls = faces.filter((f) => f.part === 'wall' && Math.abs(f.normal[2]) === 1);
  expect(walls).toHaveLength(2);
  const front = walls.find((f) => f.normal[2] === 1 && f.facing)!;
  expect(front.holes).toHaveLength(2);
  const b64 = await shot(page);
  // Through the middle of each opening there is only the background (#09090b).
  for (const hole of front.holes) {
    const x = hole.reduce((a, p) => a + p[0], 0) / 4;
    const y = hole.reduce((a, p) => a + p[1], 0) / 4;
    const [r, g, b] = await pixelAt(page, b64, x, y);
    expect(Math.abs(r - 9) + Math.abs(g - 9) + Math.abs(b - 11)).toBeLessThanOrEqual(6);
  }
});

test('frames are neutral by default, "Marcos" textures them, and the choice is remembered', async ({ page }) => {
  await importBricks(page);
  await choose(page, 'view3d-shape', 'Pared con huecos');
  await settleFrames(page);
  // Import leaves the project dirty: start clean, so a part toggle that dirtied it would show.
  await page.evaluate(() => window.__hs!.store.setState({ dirty: false }));
  // The largest frame face toward the camera: a door jamb's front.
  const frame = (await page.evaluate(() => window.__hs!.view3d.faces()))
    .filter((f: FaceInfo) => f.part === 'frames' && f.facing && f.normal[2] === 1)
    .sort((a: FaceInfo, b: FaceInfo) => quadArea(b.screen) - quadArea(a.screen))[0];
  const byDefault = await faceMean(page, await shot(page), frame.screen);
  expect(byDefault.n).toBeGreaterThan(300);

  await setPart(page, 'Marcos', true);
  await settleFrames(page);
  const textured = await faceMean(page, await shot(page), frame.screen);

  // Everything neutral: the reference grey of that face.
  for (const name of ['Pared', 'Columnas', 'Marcos']) await setPart(page, name, false);
  await settleFrames(page);
  const neutral = await faceMean(page, await shot(page), frame.screen);

  expect(maxChannelDiff(byDefault.rgb, neutral.rgb)).toBeLessThanOrEqual(12);
  expect(maxChannelDiff(textured.rgb, byDefault.rgb)).toBeGreaterThan(12);

  await setPart(page, 'Marcos', true);
  expect(await page.evaluate(() => window.__hs!.store.getState().dirty)).toBe(false);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('hs.view3d')))!).textured).toEqual({
    body: true, wall: false, columns: false, frames: true, skirting: false, floor: true, ceiling: true,
  });
  await page.reload();
  await expect(page.getByTestId('view3d-shape')).toHaveText('Pared con huecos');
  await page.getByTestId('view3d-parts').click();
  await expect(page.getByRole('checkbox', { name: 'Marcos', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Pared', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Columnas', exact: true })).not.toBeChecked();
  // Only the current shape's parts, in their order.
  const menu = page.getByTestId('view3d-parts-menu');
  await expect(menu.getByRole('checkbox')).toHaveCount(3);
  expect(await menu.getByRole('checkbox').evaluateAll((els) => els.map((e) => e.closest('label')!.textContent))).toEqual(
    ['Pared', 'Columnas', 'Marcos'],
  );

  // A stored value without the parts falls back to the defaults.
  await page.evaluate(() => localStorage.setItem('hs.view3d', JSON.stringify({ shape: 'corridor' })));
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__hs?.store.getState().view3d.textured)).toEqual({
    body: true, wall: true, columns: true, frames: false, skirting: false, floor: true, ceiling: true,
  });
});

test('with every part neutral the shape is plain grey and recompositions still reach the view', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    // The dev server has no favicon and no /api/update (the update notice treats that 404 as "no update"):
    // the browser's own logging of those 404s is expected on every page.
    const url = m.location().url;
    if (m.type() === 'error' && !url.endsWith('/favicon.ico') && !url.endsWith('/api/update')) errors.push(`${m.text()} ${m.location().url}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await importBricks(page);
  await choose(page, 'view3d-shape', 'Pared con huecos');
  for (const name of ['Pared', 'Columnas']) await setPart(page, name, false);
  await settleFrames(page);

  /** Shape pixels (not the background) and how many of them are not grey (channels more than 8 apart). */
  const greyness = (b64: string) => page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let shape = 0, coloured = 0, offMid = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
      if (Math.abs(r - 9) + Math.abs(gg - 9) + Math.abs(b - 11) <= 6) continue;
      shape++;
      if (Math.max(r, gg, b) - Math.min(r, gg, b) > 8) coloured++;
      if (Math.abs((r + gg + b) / 3 - 128) > 3) offMid++;
    }
    return { shape, coloured, offMid };
  }, b64);

  const lit = await greyness(await shot(page));
  expect(lit.shape).toBeGreaterThan(20_000);
  expect(lit.coloured / lit.shape).toBeLessThan(0.01);
  expect((await stats(page, await shot(page))).variance).toBeGreaterThan(100);

  // Unlit maps show flat mid grey on neutral parts (antialiased silhouette edges aside).
  await choose(page, 'view3d-mode', 'BaseColor');
  await settleFrames(page);
  const flat = await greyness(await shot(page));
  expect(flat.shape).toBeGreaterThan(20_000);
  expect(flat.offMid / flat.shape).toBeLessThan(0.05);

  const gen = await page.evaluate(() => window.__hs!.view3dTextureGen);
  await page.evaluate(() => window.__hs!.store.getState().updateNode('wear', { seed: 9 }));
  await expect.poll(() => page.evaluate(() => window.__hs!.view3dTextureGen)).toBeGreaterThan(gen);
  await settle(page);
  expect(errors).toEqual([]);
});

test('the toolbar fits on one row at a 50 % split on a 1600 px window', async ({ page }) => {
  await importBricks(page);
  // The widest choices.
  await choose(page, 'view3d-shape', 'Pared con huecos');
  await choose(page, 'view3d-mode', 'Rectángulos');
  await expect(page.getByTestId('view3d-parts')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Encajar vista' })).toHaveAttribute('title', /Encajar vista/);
  const toolbar = page.getByTestId('view3d-toolbar');
  // One row: every control's vertical centre on the same line (they differ in height, so their tops do not).
  const centres = await toolbar.evaluate((el) => [...el.children].map((c) => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2;
  }));
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(2);
  expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(34);
});

test('unmounting and remounting 10 times leaks no textures or WebGL contexts', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => { if (/WebGL/i.test(m.text())) warnings.push(m.text()); });
  await importBricks(page);
  const baseline = await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
  }));
  expect(baseline.gpu).toBeGreaterThan(0);
  for (let i = 0; i < 10; i++) {
    const gen = await page.evaluate(() => window.__hs!.view3dTextureGen);
    await page.evaluate(() => window.__hs!.view3d.remount());
    await expect.poll(() => page.evaluate(() => window.__hs!.view3dTextureGen)).toBeGreaterThan(gen);
  }
  await settle(page);
  const after = await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
    renderers: window.__hs!.view3d.renderers,
  }));
  expect(after).toEqual({ ...baseline, renderers: 1 });
  expect(warnings.filter((w) => /too many active/i.test(w))).toEqual([]);
});

test('with the atlas maximized the 3D view neither draws nor reads back, and catches up when shown', async ({ page }) => {
  await importBricks(page);
  await page.getByRole('button', { name: 'Maximizar atlas 2D' }).click();
  await expect(page.getByTestId('viewport-3d')).toBeHidden();
  const frames = await settleFrames(page);
  const before = await page.evaluate(() => ({ reads: window.__hs!.view3d.reads, gen: window.__hs!.view3dTextureGen }));
  const atlas = await page.evaluate(() => {
    const hs = window.__hs!;
    (window as unknown as { __atlas: unknown }).__atlas = hs.store.getState().atlas;
    hs.store.getState().setView3d({ lightAzimuthDeg: 120, mode: 'rects' });
    hs.store.getState().updateNode('wear', { seed: 5 });
    return true;
  });
  expect(atlas).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().atlas !== (window as unknown as { __atlas: unknown }).__atlas)).toBe(true);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__hs!.view3dFrames)).toBe(frames);
  expect(await page.evaluate(() => ({ reads: window.__hs!.view3d.reads, gen: window.__hs!.view3dTextureGen })))
    .toEqual(before);

  await page.getByRole('button', { name: 'Restaurar vistas' }).click();
  await expect.poll(() => page.evaluate(() => window.__hs!.view3dTextureGen)).toBeGreaterThan(before.gen);
  await settle(page);
  expect(await page.evaluate(() => window.__hs!.view3dFrames)).toBeGreaterThan(frames);
});

test('the normal map follows the GL convention and the rows are not flipped', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__hs?.view3d.renderers ?? 0)).toBe(1);
  const p = (await page.evaluate(() => window.__hs!.view3d.probe()))!;
  // Light from above: the top half, whose normal leans up (+v), is the brighter one.
  expect(p.litTop).toBeGreaterThan(p.litBottom + 10);
  // The colour texture's top row (red) is on top.
  expect(p.colorTop[0]).toBeGreaterThan(200);
  expect(p.colorTop[2]).toBeLessThan(50);
  expect(p.colorBottom[2]).toBeGreaterThan(200);
  expect(p.colorBottom[0]).toBeLessThan(50);
});

test('the 3D settings are remembered in localStorage, not in the project', async ({ page }) => {
  await importBricks(page);
  // Import leaves the project dirty: start clean, so a view setting that dirtied it would show.
  await page.evaluate(() => window.__hs!.store.setState({ dirty: false }));
  await choose(page, 'view3d-shape', 'Escalera');
  await choose(page, 'view3d-mode', 'Normal');
  await page.getByTestId('view3d-point-filter').click();
  expect(await page.evaluate(() => window.__hs!.store.getState().dirty)).toBe(false);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('hs.view3d')))!)).toMatchObject({
    shape: 'stairs', mode: 'normal', pointFilter: true,
  });
  await page.reload();
  await expect(page.getByTestId('view3d-shape')).toHaveText('Escalera');
  await expect(page.getByTestId('view3d-mode')).toHaveText('Normal');
  await expect(page.getByTestId('view3d-point-filter')).toHaveAttribute('aria-checked', 'true');

  // Damaged or invalid values fall back to the defaults, field by field.
  await page.evaluate(() => localStorage.setItem('hs.view3d', JSON.stringify({ shape: 'pyramid', mode: 'ao', lightElevationDeg: 'x' })));
  await page.reload();
  await expect(page.getByTestId('view3d-shape')).toHaveText('Cubo');
  await expect(page.getByTestId('view3d-mode')).toHaveText('AO');
  await expect(page.getByTestId('view3d-light-elevation')).toHaveValue('45');
  await page.evaluate(() => localStorage.setItem('hs.view3d', '{bad'));
  await page.reload();
  await expect(page.getByTestId('view3d-mode')).toHaveText('Iluminado');
});

test('at a 1024 px preview the 3D view reads its own 2048 px atlas', async ({ page }) => {
  await importBricks(page);
  const r = await page.evaluate(() => {
    const hs = window.__hs!;
    const s = hs.store.getState();
    return {
      preview: s.atlas!.resolutionPx, own: s.view3dAtlas!.resolutionPx, distinct: s.view3dAtlas !== s.atlas,
      width: hs.view3d.textureWidth(),
    };
  });
  expect(r).toEqual({ preview: 1024, own: 2048, distinct: true, width: 2048 });
});

test('with the 3D pane hidden no 2048 px compose runs; restored, exactly one runs', async ({ page }) => {
  await importBricks(page);
  await page.getByRole('button', { name: 'Maximizar atlas 2D' }).click();
  await expect(page.getByTestId('viewport-3d')).toBeHidden();
  const before = await page.evaluate(() => {
    const hs = window.__hs!;
    (window as unknown as { __atlas: unknown }).__atlas = hs.store.getState().atlas;
    hs.store.getState().updateNode('wear', { seed: 9 });
    return hs.compose3dCount;
  });
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().atlas !== (window as unknown as { __atlas: unknown }).__atlas)).toBe(true);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__hs!.compose3dCount)).toBe(before);

  await page.getByRole('button', { name: 'Restaurar vistas' }).click();
  await settle(page);
  expect(await page.evaluate(() => ({ count: window.__hs!.compose3dCount, width: window.__hs!.view3d.textureWidth() })))
    .toEqual({ count: before + 1, width: 2048 });
});

test('at a 2048 px preview the 3D view reads the preview atlas and composes nothing of its own', async ({ page }) => {
  await importBricks(page);
  await page.evaluate(() => window.__hs!.store.getState().setPreviewRes(2048));
  await expect.poll(() => page.evaluate(() => window.__hs!.store.getState().atlas?.resolutionPx)).toBe(2048);
  await settle(page);
  const count = await page.evaluate(() => {
    const hs = window.__hs!;
    (window as unknown as { __atlas: unknown }).__atlas = hs.store.getState().atlas;
    hs.store.getState().updateNode('wear', { seed: 4 });
    return hs.compose3dCount;
  });
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().atlas !== (window as unknown as { __atlas: unknown }).__atlas)).toBe(true);
  await settle(page);
  expect(await page.evaluate(() => {
    const hs = window.__hs!;
    const s = hs.store.getState();
    return { count: hs.compose3dCount, same: s.view3dAtlas === s.atlas, width: hs.view3d.textureWidth() };
  })).toEqual({ count, same: true, width: 2048 });
});

test('five recompositions leave as many 3D textures alive as before', async ({ page }) => {
  await importBricks(page);
  const baseline = await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
  }));
  for (let seed = 20; seed < 25; seed++) {
    const gen = await page.evaluate(() => window.__hs!.view3dTextureGen);
    await page.evaluate((v) => window.__hs!.store.getState().updateNode('wear', { seed: v }), seed);
    await expect.poll(() => page.evaluate(() => window.__hs!.view3dTextureGen)).toBeGreaterThan(gen);
  }
  await settle(page);
  expect(await page.evaluate(() => ({
    gpu: window.__hs!.view3d.gpuTextures(), live: window.__hs!.view3d.liveTextures,
  }))).toEqual(baseline);
});
