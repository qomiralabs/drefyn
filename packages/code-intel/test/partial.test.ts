import { describe, expect, it } from 'vitest';
import { extractFile, loadGrammars } from '../src/index.ts';
import type { CodeLanguage } from '../src/index.ts';

// Each file breaks in the middle. What parsed before the break still comes back.
const BROKEN: readonly (readonly [CodeLanguage, string, string])[] = [
  [
    'typescript',
    'export function before(a: string): string { return a; }\nexport function broken(a: string {\n',
    'before',
  ],
  ['tsx', 'export const Before = () => <b>ok</b>;\nexport const Broken = () => <b>;\n', 'Before'],
  ['javascript', 'export function before() {}\nexport class {{{\n', 'before'],
  ['python', 'def before():\n    pass\n\ndef broken(:\n    pass\n', 'before'],
  ['go', 'package a\n\nfunc Before() {}\n\nfunc Broken( {\n', 'Before'],
  ['rust', 'pub fn before() {}\n\npub fn broken( -> {\n', 'before'],
];

describe('a file with syntax errors', () => {
  it.each(BROKEN)('%s returns what parsed and partial', async (language, source, name) => {
    const grammars = await loadGrammars();
    const result = extractFile(language, source, grammars, { path: 'broken' });
    expect(result.partial).toBe(true);
    expect(result.symbols.map((symbol) => symbol.name)).toContain(name);
  });

  it.each([
    ['empty', ''],
    ['only a BOM', '﻿'],
    ['NUL bytes', '\u0000\u0000\u0000'],
    ['a lone surrogate', 'const a = "\uD800";'],
  ])('handles %s without throwing', async (_case, source) => {
    const grammars = await loadGrammars();
    for (const language of ['typescript', 'python', 'go', 'rust'] as const) {
      expect(() => extractFile(language, source, grammars)).not.toThrow();
    }
  });

  it('sets partial for a top level Rust macro that may define items', async () => {
    const source = 'lazy_static! { pub static ref X: u8 = 1; }\npub fn a() {}\n';
    const result = extractFile('rust', source, await loadGrammars(), { path: 'lib.rs' });
    expect(result.partial).toBe(true);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['a']);
  });
});
