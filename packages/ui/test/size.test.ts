import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET = 2.5 * 1024;

describe('stylesheet size', () => {
  it('keeps the full token stylesheet under 2.5 KB gzipped', () => {
    const css = readFileSync(join(here, '../src/generated/tokens.css'));
    const gzipped = gzipSync(css).length;
    expect(gzipped).toBeLessThan(BUDGET);
  });
});
