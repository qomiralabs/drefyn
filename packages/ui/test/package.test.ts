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
  sideEffects: string[];
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
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

  it('has one more runtime entry, for components, and otherwise stylesheets and the design tool export', () => {
    const subpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
    expect(subpaths.sort()).toEqual([
      './react',
      './react.css',
      './tailwind.css',
      './tokens.css',
      './tokens.dtcg.json',
    ]);
    expect(pkg.exports['./react']).toBe('./src/react/index.ts');
    expect(pkg.exports['./react.css']).toBe('./src/react/react.css');
  });

  it('keeps stylesheets as the only side effects', () => {
    expect(pkg.sideEffects).toEqual(['*.css']);
  });

  it('takes React from the app, so one copy runs', () => {
    expect(pkg.peerDependencies).toEqual({ react: '^19.3.1', 'react-dom': '^19.3.1' });
    expect(pkg.dependencies?.['react']).toBeUndefined();
    expect(pkg.devDependencies['react']).toBe('19.3.1');
    expect(pkg.devDependencies['react-dom']).toBe('19.3.1');
  });

  it('pins every dev dependency exactly', () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // It came in only as a peer of the axe runner; pinning it holds the browser protocol.
    expect(pkg.devDependencies['playwright-core']).toBe(pkg.devDependencies['@playwright/test']);
  });

  it('exposes the typed tokens, the contrast helpers, the head script and the chart themes', () => {
    expect(Object.keys(ui).sort()).toEqual(
      [
        'aliasRoles',
        'chartMotion',
        'colorOf',
        'cubicBezier',
        'composite',
        'contrast',
        'decorativeRoles',
        'disabledCeiling',
        'disabledPairs',
        'echartsThemes',
        'fillBackdrops',
        'fillFloor',
        'floor2',
        'forbiddenPairs',
        'luminance',
        'measure',
        'minimum',
        'reducedFadeCapMs',
        'requiredPairs',
        'ruledOutPairs',
        'supplementaryMarks',
        'themeScript',
        'themeStorageKey',
        'tokens',
        'washBackdrops',
      ].sort(),
    );
  });
});
