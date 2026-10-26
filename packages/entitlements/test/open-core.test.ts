// The open core must run with no paid or hosted only service, so this package carries
// limits and nothing about money, Stripe or where a plan is stored.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('open core boundary', () => {
  it('has no runtime dependency outside the workspace', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      expect(name.startsWith('@drefyn/'), name).toBe(true);
      expect(spec).toBe('workspace:*');
    }
  });

  it('mentions no prices, Stripe or environment switches in its source', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/stripe/i);
      expect(text, file).not.toMatch(/\bprice/i);
      expect(text, file).not.toMatch(/\$\s?\d/);
      expect(text, file).not.toMatch(/process\.env/);
    }
  });

  it('exports no price or billing helpers', () => {
    for (const name of Object.keys(api)) {
      expect(name, name).not.toMatch(/price|stripe|invoice|billing|cents/i);
    }
  });

  it('carries send caps as limits, not as credits', () => {
    const sendKeys = api.LIMIT_KEYS.filter((key) => /email|sms|voice/.test(key));
    expect(sendKeys).toHaveLength(3);
    for (const key of sendKeys) expect(key).not.toMatch(/credit/i);
  });
});
