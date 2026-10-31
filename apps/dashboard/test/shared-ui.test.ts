import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Icons and toasts come from @drefyn/ui/react, so every product draws the same shapes and
// shows the same toast. A copy here would drift from the package without anyone noticing.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const sources = files(SRC).map((file) => ({
  file: relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

const matching = (pattern: RegExp) =>
  sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('shared ui in the dashboard', () => {
  it('has no local toast or icon module', () => {
    expect(existsSync(join(SRC, 'shell', 'toast.tsx'))).toBe(false);
    expect(existsSync(join(SRC, 'shell', 'icons.tsx'))).toBe(false);
  });

  it('draws no svg of its own', () => {
    expect(matching(/<svg[\s>]/)).toEqual([]);
  });

  it('builds no toast on React Aria directly', () => {
    expect(matching(/UNSTABLE_Toast/)).toEqual([]);
  });

  it('handles F6 only through the shared landmarks', () => {
    // A second F6 handler fights the one React Aria runs for the toast region.
    expect(matching(/['"]F6['"]/)).toEqual([]);
  });
});
