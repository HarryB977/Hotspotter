import * as core from '@hotspotter/core';
import * as engine from '@hotspotter/engine';
import { useProject } from '../state/store';

export interface SampleFile {
  name: string;
  bitmap: ImageBitmap;
}

export async function loadSample(dir: string): Promise<SampleFile[]> {
  const base = encodeURIComponent(dir).replace(/%2F/g, '/');
  const names: string[] = await (await fetch(`/samples-index/${base}`)).json();
  return Promise.all(
    names.map(async (name) => {
      const res = await fetch(`/samples/${base}/${encodeURIComponent(name)}`);
      const bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      return { name, bitmap };
    }),
  );
}

export interface HsHarness {
  core: typeof core;
  engine: typeof engine;
  loadSample: typeof loadSample;
  store: typeof useProject;
}

declare global {
  interface Window {
    __hs?: HsHarness;
  }
}

export function installHarness(): void {
  window.__hs = { core, engine, loadSample, store: useProject };
}
