import { win32 } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, dataDir } from '../src/config';

describe('dataDir', () => {
  it('prefers HOTSPOTTER_DATA_DIR', () => {
    expect(dataDir({ HOTSPOTTER_DATA_DIR: 'X:\\d', LOCALAPPDATA: 'C:\\L' })).toBe('X:\\d');
  });

  it('falls back to %LOCALAPPDATA%\\Hotspotter', () => {
    expect(dataDir({ LOCALAPPDATA: 'C:\\L' })).toBe('C:\\L\\Hotspotter');
  });

  it('falls back to the home folder when LOCALAPPDATA is unset', () => {
    expect(dataDir({})).toBe(win32.join(homedir(), 'AppData', 'Local', 'Hotspotter'));
  });
});

describe('APP_VERSION', () => {
  it('reads a semver from package.json in dev and tests', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
