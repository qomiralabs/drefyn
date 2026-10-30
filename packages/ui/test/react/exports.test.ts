// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as components from '../../src/react/index.ts';
import { barrelExports } from './split.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The v1 components so far. Adding or removing an export is a public API change,
// so it changes this list in the same PR.
const EXPORTS = [
  'Badge',
  'Button',
  'ButtonLink',
  'Dialog',
  'EmptyState',
  'IconAlert',
  'IconCheck',
  'IconChevronDown',
  'IconClock',
  'IconCross',
  'IconHatch',
  'IconMore',
  'Menu',
  'MenuItem',
  'MenuSection',
  'MenuSeparator',
  'Skeleton',
  'StatusDot',
  'StatusPip',
  'Switch',
  'TextField',
  'ToastRegion',
  'Tooltip',
  'toast',
];

describe('@drefyn/ui/react', () => {
  it('exports exactly the v1 components, each a function', () => {
    expect(Object.keys(components).sort()).toEqual([...EXPORTS].sort());
    for (const [name, value] of Object.entries(components)) {
      expect(typeof value, name).toBe('function');
    }
  });

  it('re-exports each from a file directly under src/react, so nothing needs a deep import', () => {
    const { exports, findings } = barrelExports(
      'index.ts',
      readFileSync(join(root, 'src', 'react', 'index.ts'), 'utf8'),
    );
    expect(findings).toEqual([]);
    for (const [name, file] of exports) {
      expect(file, name).toMatch(/^(?:icons\/)?[a-z-]+\.tsx$/);
    }
    expect([...exports.keys()].sort()).toEqual([...EXPORTS].sort());
  });
});
