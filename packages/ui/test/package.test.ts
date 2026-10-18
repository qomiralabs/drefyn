import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ui from '../src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  type: string;
  private: boolean;
  exports: Record<string, string>;
};

describe('package manifest', () => {
  it('is a private ESM source package', () => {
    expect(pkg.name).toBe('@drefyn/ui');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
    expect(pkg.exports['.']).toBe('./src/index.ts');
  });

  it('exports only named entry points that exist under src', () => {
    for (const [key, target] of Object.entries(pkg.exports)) {
      expect(key, key).not.toContain('*');
      expect(key, key).not.toContain('src');
      if (key !== './package.json') expect(target.startsWith('./src/'), key).toBe(true);
      expect(existsSync(join(root, target)), target).toBe(true);
    }
  });

  it('keeps non JavaScript subpaths to stylesheets and the design tool export', () => {
    const subpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
    expect(subpaths.sort()).toEqual(['./tailwind.css', './tokens.css', './tokens.dtcg.json']);
  });

  it('exposes the typed tokens, the contrast helpers, the head script and the chart themes', () => {
    expect(Object.keys(ui).sort()).toEqual(
      [
        'colorOf',
        'composite',
        'contrast',
        'disabledCeiling',
        'disabledPairs',
        'echartsThemes',
        'floor2',
        'forbiddenPairs',
        'luminance',
        'measure',
        'minimum',
        'reducedFadeCapMs',
        'requiredPairs',
        'ruledOutPairs',
        'themeScript',
        'themeStorageKey',
        'tokens',
      ].sort(),
    );
  });
});
