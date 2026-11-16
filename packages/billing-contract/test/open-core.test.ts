// Self hosters run this package too, so it carries the contract and nothing about who
// bills, what a plan costs, or where a provider's keys live.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  license?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
};

const sources = readdirSync(join(root, 'src')).map((name) => join(root, 'src', name));

describe('open core boundary', () => {
  it('is Apache 2.0 and not published', () => {
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.private).toBe(true);
  });

  it('depends only on the workspace and zod', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (name === 'zod') continue;
      expect(name.startsWith('@drefyn/'), name).toBe(true);
      expect(spec).toBe('workspace:*');
    }
  });

  it('names no provider, holds no price and reads no environment', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/stripe/i);
      expect(text, file).not.toMatch(/\$\s?\d/);
      expect(text, file).not.toMatch(/process\.env/);
      // A money literal in source would be a price; amounts only come from the provider.
      expect(text, file).not.toMatch(/Cents:\s*[1-9]/);
    }
  });
});
