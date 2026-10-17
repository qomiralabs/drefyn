import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fontFaces } from '../src/tokens/generate.ts';
import { readWoff2 } from './woff2.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(here, '../src/fonts');

// The Latin subset as Google Fonts and Fontsource cut it.
const LATIN: [number, number][] = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];
// Combining marks the subsetter keeps because Latin layout rules reach them, plus the A with
// breve that JetBrains Mono's rules reach. Listed one by one so anything else fails.
const KEPT_BY_LAYOUT = new Set([0x0102, 0x0300, 0x0301, 0x0303, 0x0309, 0x0323]);
const isLatin = (c: number) =>
  KEPT_BY_LAYOUT.has(c) || LATIN.some(([lo, hi]) => c >= lo && c <= hi);

const woff2Files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));

describe('self hosted fonts', () => {
  it('ships exactly the faces the stylesheet declares', () => {
    expect(woff2Files.sort()).toEqual(fontFaces.map((f) => f.file).sort());
  });

  it.each(woff2Files)('%s is a Latin subset', (file) => {
    const font = readWoff2(readFileSync(join(fontsDir, file)));
    const outside = font.codePoints.filter((c) => !isLatin(c));
    expect(outside.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`)).toEqual([]);
    // Basic Latin letters and the euro sign are in, Cyrillic and Greek are not.
    expect(font.codePoints).toEqual(expect.arrayContaining([0x41, 0x7a, 0x20ac]));
    expect(font.codePoints).not.toContain(0x0416);
    expect(font.codePoints).not.toContain(0x03a9);
  });

  it.each(woff2Files)('%s is the family it claims to be', (file) => {
    const family = readWoff2(readFileSync(join(fontsDir, file))).family;
    expect(family.startsWith(file.startsWith('inter') ? 'Inter' : 'JetBrains Mono')).toBe(true);
  });

  it('keeps each family licence beside the files', () => {
    for (const licence of ['Inter-OFL.txt', 'JetBrainsMono-OFL.txt']) {
      const path = join(fontsDir, licence);
      expect(existsSync(path), licence).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('SIL Open Font License, Version 1.1');
    }
  });

  it('has not grown past the measured 115,388 bytes', () => {
    const total = woff2Files.reduce((sum, f) => sum + readFileSync(join(fontsDir, f)).length, 0);
    expect(total).toBeLessThanOrEqual(115_388);
  });
});
