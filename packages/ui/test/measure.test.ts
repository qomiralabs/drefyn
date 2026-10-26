import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokens } from '../src/tokens/tokens.ts';
import { readWoff2 } from './woff2.ts';

// The reading measure is set in em and checked against the shipped Inter: the sample text is
// wrapped greedily at the measure using the font's own advance widths, the way a browser
// breaks lines at spaces. Kerning is left out; it moves a line by a character at most.
const here = dirname(fileURLToPath(import.meta.url));
const inter = readWoff2(readFileSync(join(here, '../src/fonts/inter-latin-400-normal.woff2')));
const paragraphs = readFileSync(join(here, 'fixtures/measure-sample.txt'), 'utf8')
  .trim()
  .split('\n');

function widthEm(text: string): number {
  let units = 0;
  for (const char of text) {
    const advance = inter.advances.get(char.codePointAt(0) ?? 0);
    if (advance === undefined) throw new Error(`Inter has no glyph for ${char}`);
    units += advance;
  }
  return units / inter.unitsPerEm;
}

// Characters on every full line; the last line of a paragraph is short by nature.
function lineLengths(measureEm: number): number[] {
  const out: number[] = [];
  for (const paragraph of paragraphs) {
    const lines: string[] = [];
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && widthEm(next) > measureEm) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    out.push(...lines.map((l) => l.length));
  }
  return out;
}

describe('reading measure', () => {
  const lengths = lineLengths(tokens.layout.measure);
  const average = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  it('sets about 70 characters per line in Inter', () => {
    expect(lengths.length).toBeGreaterThan(15);
    expect(average).toBeGreaterThanOrEqual(68);
    expect(average).toBeLessThanOrEqual(72);
  });

  it('never runs a line past 78 characters', () => {
    expect(Math.max(...lengths)).toBeLessThanOrEqual(78);
  });

  it('fits the docs reading column at the largest body size', () => {
    const widest = tokens.layout.measure * tokens.type.bodyL.size;
    expect(widest).toBeLessThanOrEqual(tokens.layout.docs.content);
  });

  it('would fail the old 66ch, which set 83 characters', () => {
    const zero = (inter.advances.get(0x30) ?? 0) / inter.unitsPerEm;
    const old = lineLengths(66 * zero);
    expect(old.reduce((a, b) => a + b, 0) / old.length).toBeGreaterThan(80);
  });
});
