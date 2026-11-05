import { describe, expect, it } from 'vitest';
import { codes, issuesOf, parsed } from './helpers.ts';

const HTML_PAGE = 'Intro\n\n<!-- a note -->\n\n<br>\n';

describe('dialects', () => {
  it('parses .md with no MDX syntax', () => {
    expect(parsed('<div>{x}</div>\n\nimport a\n', 'md').children.map(({ type }) => type)).toEqual([
      'html',
      'paragraph',
    ]);
  });

  it('parses .mdx with JSX, ESM and expressions', () => {
    const ast = parsed('import a from "a"\n\n<A />\n\n{b}\n', 'mdx');
    expect(ast.children.map(({ type }) => type)).toEqual([
      'mdxjsEsm',
      'mdxJsxFlowElement',
      'mdxFlowExpression',
    ]);
  });

  it('reads GFM and frontmatter in both', () => {
    for (const dialect of ['md', 'mdx'] as const) {
      const ast = parsed('---\na: 1\n---\n\n| a |\n| - |\n| b |\n', dialect);
      expect(ast.children.map(({ type }) => type)).toEqual(['yaml', 'table']);
    }
  });

  it('stays quiet on a plain page in either dialect', () => {
    expect(issuesOf('# Title\n\nText with <b>html</b>.\n', 'md')).toEqual([]);
    expect(issuesOf('# Title\n\nText.\n', 'mdx')).toEqual([]);
  });

  it.each([
    ['a component', '<Tabs>\n\nHello\n'],
    ['an import', 'import A from "./a"\n'],
    ['an export', 'export const a = 1\n'],
  ])('warns when a .md page holds %s', (_name, source) => {
    expect(issuesOf(source, 'md')).toEqual([
      { code: 'mdx.dialect_mismatch', severity: 'warning', line: 1, column: 1 },
    ]);
  });

  it('does not warn on a .md paragraph that only starts like ESM', () => {
    expect(issuesOf('import the data first\n', 'md')).toEqual([]);
    expect(issuesOf('export your site\n', 'md')).toEqual([]);
    expect(issuesOf('<div>plain html</div>\n', 'md')).toEqual([]);
  });

  it('adds a hint when a .mdx page fails on Markdown only HTML', () => {
    expect(codes(issuesOf(HTML_PAGE, 'mdx'))).toEqual(['mdx.parse_failed', 'mdx.dialect_mismatch']);
  });

  it('gives no hint for plain broken MDX', () => {
    expect(codes(issuesOf('{\n', 'mdx'))).toEqual(['mdx.parse_failed']);
  });
});
