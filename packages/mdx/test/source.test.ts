import { describe, expect, it } from 'vitest';
import { AST_VERSION } from '../src/index.ts';
import { serialize } from '../src/serialize.ts';
import { parsed } from './helpers.ts';

const BOM = String.fromCharCode(0xfeff);

describe('block source', () => {
  it('keeps each block and the gap before it', () => {
    const ast = parsed('# One\n\n\nTwo\n', 'md');
    expect(ast).toMatchObject({ type: 'root', astVersion: AST_VERSION, dialect: 'md', tail: '\n' });
    expect(ast.children.map((block) => block.source?.raw)).toEqual(['# One', 'Two']);
    expect(ast.children.map((block) => block.source?.gapBefore)).toEqual(['', '\n\n\n']);
  });

  it('keeps a document with no blocks in the tail', () => {
    for (const source of ['', '\n\n', '   \t', '\r\n', BOM, `${BOM}\n`]) {
      const ast = parsed(source, 'mdx');
      expect(ast.children).toEqual([]);
      expect(ast.tail).toBe(source);
      expect(serialize(ast)).toBe(source);
    }
  });

  it('puts a BOM in the first gap so offsets stay true', () => {
    const ast = parsed(`${BOM}# One\n\nTwo\n`, 'md');
    expect(ast.children.map((block) => block.source?.raw)).toEqual(['# One', 'Two']);
    expect(ast.children[0]?.source?.gapBefore).toBe(BOM);
    expect(ast.children[1]?.source?.gapBefore).toBe('\n\n');
  });

  it('keeps offsets true after more than one BOM', () => {
    const ast = parsed(`${BOM}${BOM}# One\n`, 'md');
    expect(ast.children[0]?.source?.raw).toBe('# One');
    expect(ast.children[0]?.source?.gapBefore).toBe(`${BOM}${BOM}`);
  });

  it('reads frontmatter after a BOM', () => {
    expect(parsed(`${BOM}---\na: 1\n---\n\nBody\n`, 'mdx').children[0]?.type).toBe('yaml');
  });

  it('keeps indent with the block, so a gap ends at a line start', () => {
    const ast = parsed('One\n\n  Two\n\n \t- three\n', 'md');
    expect(ast.children.map((block) => block.source?.raw)).toEqual(['One', '  Two', ' \t- three']);
    expect(ast.children.map((block) => block.source?.gapBefore)).toEqual(['', '\n\n', '\n\n']);
  });

  it('takes the line ending from the majority', () => {
    expect(parsed('a\n\nb\n', 'md').eol).toBe('lf');
    expect(parsed('a\r\n\r\nb\r\n', 'md').eol).toBe('crlf');
    expect(parsed('a\r\n\r\nb\n', 'md').eol).toBe('crlf');
    expect(parsed('a\r\n\nb\n', 'md').eol).toBe('lf');
    expect(parsed('no line ending', 'md').eol).toBe('lf');
  });

  it('stores no positions or parser data', () => {
    const json = JSON.stringify(
      parsed('---\na: 1\n---\n\n<A b={1} {...c}>{d}</A>\n\nexport const e = 1\n', 'mdx'),
    );
    expect(json).not.toContain('"position"');
    expect(json).not.toContain('"data"');
    expect(json).not.toContain('estree');
  });
});
