import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
});

/** Compute-shader body that writes `expr` (a WGSL f32 expression of `p`, the pixel coordinate) per texel. */
function body(expr: string): string {
  return `
@group(0) @binding(0) var out: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(out);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let p = vec2<f32>(f32(id.x), f32(id.y));
  textureStore(out, vec2<i32>(id.xy), vec4<f32>(${expr}, 0.0, 0.0, 1.0));
}`;
}

async function run(page: Page, expr: string, w = 256, h = 256): Promise<number[]> {
  return page.evaluate(
    async ([code, w, h]) => Array.from(await window.__hs!.runCompute(code as string, w as number, h as number)),
    [body(expr), w, h] as const,
  );
}

test('hash31 is deterministic and has mean 0.5 over 256x256', async ({ page }) => {
  const expr = 'hash31(vec3<f32>(p, 0.0), 7u)';
  const a = await run(page, expr);
  const b = await run(page, expr);
  expect(b).toEqual(a);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  expect(mean).toBeGreaterThan(0.48);
  expect(mean).toBeLessThan(0.52);
  expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...a)).toBeLessThan(1);
});

test('fbm is continuous at frequency 1/32 px', async ({ page }) => {
  const v = await run(page, 'fbm(p / 32.0, 4u, 3u)');
  let maxDiff = 0;
  let sumDiff = 0;
  let n = 0;
  const step = (a: number, b: number): void => {
    const d = Math.abs(v[a] - v[b]);
    maxDiff = Math.max(maxDiff, d);
    sumDiff += d;
    n++;
  };
  for (let y = 0; y < 256; y++) for (let x = 0; x < 255; x++) step(y * 256 + x + 1, y * 256 + x);
  for (let y = 0; y < 255; y++) for (let x = 0; x < 256; x++) step((y + 1) * 256 + x, y * 256 + x);
  // The mean step is well under 0.05; the worst step of 4 octaves measured 0.057, so 0.1 guards against jumps.
  expect(sumDiff / n).toBeLessThan(0.05);
  expect(maxDiff).toBeLessThan(0.1);
});

test('voronoi with anisotropy 4 stretches cells along X', async ({ page }) => {
  const hit = 'voronoi(p / 16.0, 4.0, 5u)';
  const id = await run(page, `f32(${hit}.cell.x + 64) * 256.0 + f32(${hit}.cell.y + 64)`);
  // Mean run length of a constant cell id along X versus along Y.
  const meanRun = (stepX: number, stepY: number): number => {
    let runs = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const px = x - stepX;
        const py = y - stepY;
        if (px < 0 || py < 0 || id[py * 256 + px] !== id[y * 256 + x]) runs++;
      }
    }
    return (256 * 256) / runs;
  };
  expect(meanRun(1, 0) / meanRun(0, 1)).toBeGreaterThan(2.5);
});

test('a different seed gives a different pattern', async ({ page }) => {
  const a = await run(page, 'fbm(p / 32.0, 4u, 1u)');
  const b = await run(page, 'fbm(p / 32.0, 4u, 2u)');
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  expect(same / a.length).toBeLessThan(0.1);
});
