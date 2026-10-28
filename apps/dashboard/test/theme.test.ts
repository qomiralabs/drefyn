import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, currentTheme } from '../src/shell/theme.ts';

// The node environment has no DOM, so the two globals the module touches are stood in.
let store: Map<string, string>;
let dataset: Record<string, string | undefined>;
let storageThrows = false;

beforeEach(() => {
  store = new Map();
  dataset = {};
  storageThrows = false;
  Object.assign(globalThis, {
    document: { documentElement: { dataset } },
    localStorage: {
      setItem: (k: string, v: string) => {
        if (storageThrows) throw new Error('storage off');
        store.set(k, v);
      },
      removeItem: (k: string) => {
        if (storageThrows) throw new Error('storage off');
        store.delete(k);
      },
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('the theme choice', () => {
  it('stores light or dark under the key the head script reads and applies it', () => {
    applyTheme('dark');
    expect(store.get('dr-theme')).toBe('dark');
    expect(dataset['theme']).toBe('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('clears both for system, so the stylesheet follows the operating system', () => {
    applyTheme('light');
    applyTheme('system');
    expect(store.has('dr-theme')).toBe(false);
    expect(dataset['theme']).toBeUndefined();
    expect(currentTheme()).toBe('system');
  });

  it('still applies to the page when storage is off', () => {
    storageThrows = true;
    applyTheme('light');
    expect(dataset['theme']).toBe('light');
  });
});
