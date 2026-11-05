import { describe, expect, it } from 'vitest';
import { parseForStore } from '../src/index.ts';
import type { Dialect } from '../src/index.ts';
import { codes, limits, parsed, policy } from './helpers.ts';

const MIB = 1_048_576;
// Far past anything a healthy parse takes, far short of the minutes the stock parser needs.
const QUICK_MS = 1_000;

const fill = (unit: string, bytes = MIB) => unit.repeat(Math.floor(bytes / unit.length));

function refuse(source: string, dialect: Dialect) {
  const started = performance.now();
  const result = parseForStore(source, dialect, policy());
  const elapsed = performance.now() - started;
  if (result.ok) throw new Error('was not refused');
  return { found: codes(result.error), elapsed };
}

describe('input that sends the parser quadratic', () => {
  it.each([
    ['quotes', '>', 'mdx.too_deep'],
    ['spaced quotes', '> ', 'mdx.too_deep'],
    ['bullets', '- ', 'mdx.too_deep'],
    ['ordered lists', '1. ', 'mdx.too_deep'],
    ['ordered lists with parens', '123) ', 'mdx.too_deep'],
    ['emphasis', 'a*', 'mdx.too_many_nodes'],
    ['emphasis pairs', '*a* ', 'mdx.too_many_nodes'],
    ['link openers', '[a](', 'mdx.too_many_nodes'],
    ['references', '[a]\n', 'mdx.too_many_nodes'],
    ['footnote calls', '[^a]', 'mdx.too_many_nodes'],
    ['setext lines', 'a\n=\n', 'mdx.too_many_nodes'],
    ['task markers', '- [ ] ', 'mdx.too_many_nodes'],
  ])('refuses a mebibyte of %s before parsing it', (_name, unit, code) => {
    for (const dialect of ['md', 'mdx'] as const) {
      const { found, elapsed } = refuse(fill(unit), dialect);
      expect(found).toEqual([code]);
      expect(elapsed).toBeLessThan(QUICK_MS);
    }
  });

  it('refuses expressions left open across blank lines', () => {
    const { found, elapsed } = refuse(fill('{{}\n\n'), 'mdx');
    expect(found).toEqual(['mdx.too_many_nodes']);
    expect(elapsed).toBeLessThan(QUICK_MS);
  });

  it('counts a run of syntax across lines but not across blank ones', () => {
    const paragraph = `${'*a* '.repeat(1_200)}\n`;
    expect(parsed(`${paragraph}\n`.repeat(2), 'md').children).toHaveLength(2);
    expect(codes(issuesFor(paragraph.repeat(2)))).toEqual(['mdx.too_many_nodes']);
  });

  it('leaves balanced expressions and plain nesting alone', () => {
    expect(parsed('{{ a: 1 }}\n\n{{ b: 2 }}\n', 'mdx').children).toHaveLength(2);
    expect(parsed(`\`\`\`\n${'>'.repeat(200)}\n\`\`\`\n`, 'md').children).toHaveLength(1);
    expect(parsed(`\`\`\`\n${'{'.repeat(4_000)}\n\`\`\`\n`, 'md').tail).toBe('\n');
  });

  it('turns a parser stack overflow into a refusal', () => {
    const deep = `{${'['.repeat(100_000)}\n`;
    const result = parseForStore(deep, 'mdx', limits({ maxBytes: 200_000 }));
    expect(result.ok).toBe(false);
  });
});

function issuesFor(source: string) {
  const result = parseForStore(source, 'md', policy());
  return result.ok ? result.value.issues : result.error;
}
