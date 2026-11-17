import { describe, expect, it } from 'vitest';
import { chooseBrowser, parseProgId } from '../src/browser';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

describe('chooseBrowser', () => {
  it('uses Chrome when it is the default and both are installed', () => {
    expect(chooseBrowser('ChromeHTML', { chrome, edge })).toEqual({ exe: chrome });
  });

  it('uses Edge when it is the default', () => {
    expect(chooseBrowser('MSEdgeHTM', { chrome, edge })).toEqual({ exe: edge });
  });

  it('falls back to the installed one when the default is another browser', () => {
    expect(chooseBrowser('FirefoxURL-308046B0AF4A39CB', { edge })).toEqual({ exe: edge });
  });

  it('falls back when the default cannot be read', () => {
    expect(chooseBrowser(null, { chrome })).toEqual({ exe: chrome });
  });

  it('returns null when neither is installed', () => {
    expect(chooseBrowser('ChromeHTML', {})).toBeNull();
  });
});

describe('parseProgId', () => {
  it('reads the ProgId value from reg query output', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n' +
      '    ProgId    REG_SZ    ChromeHTML\r\n\r\n';
    expect(parseProgId(out)).toBe('ChromeHTML');
  });

  it('returns null when the value is missing', () => {
    expect(parseProgId('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});
