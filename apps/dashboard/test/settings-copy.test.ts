import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Seat numbers come from entitlements at render time. A plan name or a limit written into a
// settings screen would go stale the day the table moves, so this reads every source file.
const ROOTS = ['../src/settings', '../src/app/account', '../src/app/[org]/settings/members'];
const GALLERY = 'gallery.tsx';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && entry.name !== GALLERY ? [path] : [];
  });
}

const sources = ROOTS.flatMap((root) =>
  files(fileURLToPath(new URL(root, import.meta.url))).map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  })),
);

describe('settings copy', () => {
  it('reads real files', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it('names no plan tier in a string', () => {
    const tier = /['"`>][^'"`<]*\b(Free|Starter|Growth|Scale|Enterprise)\b[^'"`<]*['"`<]/;
    expect(sources.filter(({ text }) => tier.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it('writes no seat number', () => {
    const seats = /\b\d+ (of \d+ )?seats?\b/;
    expect(sources.filter(({ text }) => seats.test(text)).map(({ path }) => path)).toEqual([]);
  });
});
