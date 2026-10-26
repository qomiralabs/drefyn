import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { themeScript, themeStorageKey } from '../src/theme-script.ts';

function run(stored: string | null | Error): Record<string, string> {
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem(key: string) {
      if (stored instanceof Error) throw stored;
      return key === themeStorageKey ? stored : null;
    },
  };
  runInNewContext(themeScript, { localStorage, document: { documentElement: { dataset } } });
  return dataset;
}

describe('head theme script', () => {
  it('fits in 139 bytes', () => {
    expect(new TextEncoder().encode(themeScript).length).toBeLessThanOrEqual(139);
  });

  it('applies a stored light or dark choice before paint', () => {
    expect(run('dark')).toEqual({ theme: 'dark' });
    expect(run('light')).toEqual({ theme: 'light' });
  });

  it('leaves the system preference in charge when nothing valid is stored', () => {
    expect(run(null)).toEqual({});
    expect(run('dark-warm')).toEqual({});
    expect(run('"><script>')).toEqual({});
  });

  it('never throws when storage is blocked', () => {
    expect(run(new Error('SecurityError'))).toEqual({});
  });

  it('is static, so one CSP hash covers every page', () => {
    expect(themeScript).not.toMatch(/\$\{|`/);
  });
});
