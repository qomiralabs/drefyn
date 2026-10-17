import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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

interface AssetRow {
  source: string;
  version: string;
  licence: string;
  sha256: string;
}

// The font table in ASSETS.md is the record of where each file came from. Reading it here
// means a swapped file fails until the record is updated too, in the same review.
function readAssetRows(): Map<string, AssetRow> {
  const markdown = readFileSync(join(here, '../../../ASSETS.md'), 'utf8');
  const section = markdown.split(/^## /m).find((s) => s.startsWith('Fonts'));
  if (section === undefined) throw new Error('ASSETS.md has no Fonts section');
  const rows = new Map<string, AssetRow>();
  const code = (cell: string) => /^`([^`]*)`$/.exec(cell.trim())?.[1] ?? cell.trim();
  for (const line of section.split('\n')) {
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== 5) continue;
    const [file, source, version, licence, sha256] = cells.map(code) as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/\.(woff2|txt)$/.test(file)) continue;
    rows.set(file, { source, version, licence, sha256 });
  }
  return rows;
}

const assetRows = readAssetRows();

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

  it.each(woff2Files)('%s is the release ASSETS.md records', (file) => {
    const row = assetRows.get(file);
    expect(row, file).toBeDefined();
    if (row === undefined) return;
    expect(readWoff2(readFileSync(join(fontsDir, file))).version).toBe(row.version);
    // An exact, immutable tarball, so anyone can fetch the same bytes and compare.
    const pkg = file.startsWith('inter') ? 'inter' : 'jetbrains-mono';
    expect(row.source).toMatch(
      new RegExp(
        `^https://registry\\.npmjs\\.org/@fontsource/${pkg}/-/${pkg}-\\d+\\.\\d+\\.\\d+\\.tgz$`,
      ),
    );
    expect(row.licence).toBe(file.startsWith('inter') ? 'Inter-OFL.txt' : 'JetBrainsMono-OFL.txt');
  });

  it('records every file in the fonts folder with a matching SHA-256', () => {
    expect([...assetRows.keys()].sort()).toEqual(readdirSync(fontsDir).sort());
    for (const [file, row] of assetRows) {
      const digest = createHash('sha256')
        .update(readFileSync(join(fontsDir, file)))
        .digest('hex');
      expect(digest, file).toBe(row.sha256);
    }
  });

  it.each(['Inter-OFL.txt', 'JetBrainsMono-OFL.txt'])('%s is the full OFL 1.1 text', (licence) => {
    const text = readFileSync(join(fontsDir, licence), 'utf8');
    for (const part of [
      'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
      'PREAMBLE',
      'DEFINITIONS',
      'PERMISSION & CONDITIONS',
      '5) The Font Software, modified or unmodified, in part or in whole,',
      'TERMINATION',
      'DISCLAIMER',
    ]) {
      expect(text, part).toContain(part);
    }
    const project = licence.startsWith('Inter')
      ? 'The Inter Project Authors'
      : 'The JetBrains Mono Project Authors';
    expect(text.split('\n')[0]).toContain(
      `Copyright ${licence.startsWith('Inter') ? 2016 : 2020} ${project}`,
    );
    // A subset is a Modified Version under the OFL, and it may keep the family name only
    // because neither project reserves one.
    expect(text).not.toMatch(/with Reserved Font Name/i);
  });

  it('has not grown past the measured 115,388 bytes', () => {
    const total = woff2Files.reduce((sum, f) => sum + readFileSync(join(fontsDir, f)).length, 0);
    expect(total).toBeLessThanOrEqual(115_388);
  });
});
