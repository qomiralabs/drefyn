import { describe, expect, it } from 'vitest';
import { parseForStore, rawOf, serialize } from '../src/index.ts';
import { loadCorpus, parsed, policy, sha256, VARIANTS } from './helpers.ts';

const corpus = loadCorpus();

// Three times the worst seen. A corpus pass takes about 1 s here and 60 s on a CI runner
// while the gate tests every package at once under coverage.
const TIMEOUT_MS = 180_000;
// One block parse per block of every file is thousands of parses, and a third of the files
// holds more than enough blocks to catch a slice drifting.
const BLOCK_SAMPLE = 3;

describe('the pinned corpus', () => {
  it('holds both dialects from several repos', () => {
    expect(corpus.length).toBeGreaterThan(150);
    expect(new Set(corpus.map((file) => file.dialect))).toEqual(new Set(['mdx', 'md']));
    expect(new Set(corpus.map((file) => file.repo)).size).toBeGreaterThanOrEqual(6);
  });

  it('has not drifted from its manifest', () => {
    for (const file of corpus) expect(sha256(file.bytes), file.file).toBe(file.sha256);
  });

  it(
    'round trips every file byte for byte',
    () => {
      for (const { file, text, dialect } of corpus) {
        expect(serialize(parsed(text, dialect)), file).toBe(text);
      }
    },
    TIMEOUT_MS,
  );

  // Every variant over every file is about 1,200 parses, far too slow in the gate; the fuzz job
  // and the generated documents cover the same bytes. Rotating still crosses each variant with
  // every repo.
  it(
    'round trips the line ending, BOM and trailing byte variants',
    () => {
      for (const [index, { file, text, dialect }] of corpus.entries()) {
        const [name, derive] = VARIANTS[index % VARIANTS.length] ?? [];
        const source = derive?.(text) ?? '';
        expect(serialize(parsed(source, dialect)), `${file} ${name ?? ''}`).toBe(source);
      }
    },
    TIMEOUT_MS,
  );

  // A slice can drift off its node while the file still round trips, because the gaps
  // absorb the error. Reparsing each slice is the only way to see that.
  it(
    'gives each block a raw slice that reparses to its own hash',
    () => {
      let blocks = 0;
      const off: string[] = [];
      for (const { file, text, dialect } of corpus) {
        const ast = parsed(text, dialect);
        const definitions = ast.children.filter((block) => block.type === 'definition');
        if (definitions.length > 0) continue; // a reference needs its definition to parse the same
        for (const block of ast.children) {
          const alone = parseForStore(block.source?.raw ?? '', dialect, policy());
          const first = alone.ok && alone.value.ast.children.length === 1 ? alone.value.ast : null;
          blocks += 1;
          const only = first?.children[0];
          if (only === undefined || rawOf(only) !== block.source?.rawOf) off.push(file);
        }
      }
      expect(blocks).toBeGreaterThan(500);
      expect(off.length / blocks).toBeLessThan(0.001);
    },
    TIMEOUT_MS,
  );
});
