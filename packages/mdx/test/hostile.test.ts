import { describe, expect, it } from 'vitest';
import { parseForStore } from '../src/index.ts';
import type { Dialect } from '../src/index.ts';
import { codes, limits, parsed, policy } from './helpers.ts';

const MIB = 1_048_576;
// A wall clock assertion would fail on a busy CI box, so the guard is the test timeout. The
// slowest case took 11 s at load 31 and all 26 take 73 s on a CI runner; the stock parser
// needs about 25 minutes for a mebibyte of `a*`, so losing a defence still fails.
const TIMEOUT_MS = 90_000;
const BUDGET_BOMB_BYTES = 200_000;

const fill = (unit: string, bytes = MIB) => unit.repeat(Math.floor(bytes / unit.length));

function refuse(source: string, dialect: Dialect) {
  const result = parseForStore(source, dialect, policy());
  if (result.ok) throw new Error('was not refused');
  return codes(result.error);
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
  ])(
    'refuses a mebibyte of %s before parsing it',
    (_name, unit, code) => {
      for (const dialect of ['md', 'mdx'] as const) {
        expect(refuse(fill(unit), dialect)).toEqual([code]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'refuses expressions left open across blank lines',
    () => {
      expect(refuse(fill('{{}\n\n'), 'mdx')).toEqual(['mdx.too_many_nodes']);
    },
    TIMEOUT_MS,
  );

  it.each([
    ['CRLF lines, which must not read as blank ones', 'a*b*\r\n'],
    ['setext underlines, spaced out or not', 'a\n=\n\n'],
    ['dash underlines', 'a\n-\n'],
  ])(
    'refuses %s',
    (_name, unit) => {
      expect(refuse(fill(unit), 'md')).toEqual(['mdx.too_many_nodes']);
    },
    TIMEOUT_MS,
  );

  it.each([
    ['an open comment', '{/*', '}\n\n'],
    ['an open template', '{`', '}\n\n'],
    ['an open string', '{"', '}\n\n'],
    ['an open paren', '{(', '}\n\n'],
    ['a comment in a prop', '<a b={/*', '}\n\n'],
    ['an open export', 'export {\n', '\n\n'],
    ['an open template in an export', 'export const a = `\n', 'b\n\n'],
  ])(
    'stops acorn retrying on %s',
    (_name, start, unit) => {
      expect(refuse(start + fill(unit, BUDGET_BOMB_BYTES), 'mdx')).toEqual(['mdx.too_many_nodes']);
    },
    TIMEOUT_MS,
  );

  it('counts a run of syntax across lines but not across blank ones', () => {
    const paragraph = `${'*a* '.repeat(600)}\n`;
    expect(parsed(`${paragraph}\n`.repeat(2), 'md').children).toHaveLength(2);
    expect(codes(issuesFor(paragraph.repeat(2)))).toEqual(['mdx.too_many_nodes']);
  });

  it('leaves balanced expressions and plain nesting alone', () => {
    expect(parsed('{{ a: 1 }}\n\n{{ b: 2 }}\n', 'mdx').children).toHaveLength(2);
    expect(parsed(`\`\`\`\n${'>'.repeat(200)}\n\`\`\`\n`, 'md').children).toHaveLength(1);
    expect(parsed(`\`\`\`\n${'{'.repeat(2_000)}\n\`\`\`\n`, 'md').tail).toBe('\n');
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
