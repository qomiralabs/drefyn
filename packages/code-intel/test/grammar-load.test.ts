import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser } from 'web-tree-sitter';
import { CODE_LANGUAGES, GRAMMAR_FILES, loadGrammars } from '../src/grammars.ts';
import type { CodeLanguage } from '../src/grammars.ts';

const HELLO: Record<CodeLanguage, string> = {
  typescript: 'export function hello(name: string): string { return `hi ${name}`; }\n',
  tsx: 'export const Hello = (p: { name: string }) => <p>{p.name}</p>;\n',
  javascript: 'export function hello(name) { return "hi " + name; }\n',
  python: 'def hello(name):\n    return "hi " + name\n',
  go: 'package main\n\nfunc Hello(name string) string { return "hi " + name }\n',
  rust: 'pub fn hello(name: &str) -> String { format!("hi {name}") }\n',
};

// The grammars ship prebuilt .wasm files built by their own CLI release. A runtime that cannot
// read their ABI fails here, before any extraction code is worth writing.
describe('each bundled grammar in web-tree-sitter', () => {
  it.each(CODE_LANGUAGES)('loads %s from its .wasm and parses hello world', async (language) => {
    await Parser.init();
    const grammar = await Language.load(readFileSync(GRAMMAR_FILES[language]));
    expect(grammar.abiVersion).toBeGreaterThanOrEqual(MIN_COMPATIBLE_VERSION);
    expect(grammar.abiVersion).toBeLessThanOrEqual(LANGUAGE_VERSION);

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(HELLO[language]);
    expect(tree?.rootNode.hasError).toBe(false);
    expect(tree?.rootNode.childCount).toBeGreaterThan(0);
    tree?.delete();
    parser.delete();
  });

  it('loads all six through loadGrammars, once', async () => {
    const grammars = await loadGrammars();
    expect(Object.keys(grammars.languages).sort()).toEqual([...CODE_LANGUAGES].sort());
    expect(await loadGrammars()).toBe(grammars);
  });
});
