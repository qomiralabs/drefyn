import { AST_VERSION, type MdxRoot } from '@drefyn/mdx';
import { describe, expect, it } from 'vitest';
import { astVersionOf } from '../src/index.ts';

const root: MdxRoot = {
  type: 'root',
  astVersion: AST_VERSION,
  dialect: 'mdx',
  eol: 'lf',
  children: [],
  tail: '',
  tailOf: '',
};

describe('astVersionOf', () => {
  // The column has to say what the tree says, or a later migration would pick the wrong reader.
  it('reads the version off the content, not off the running code', () => {
    const older = { ...root, astVersion: 7 } as unknown as MdxRoot;
    expect(astVersionOf(root)).toBe(AST_VERSION);
    expect(astVersionOf(older)).toBe(7);
  });
});
