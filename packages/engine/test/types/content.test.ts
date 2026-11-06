// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { MdxRoot } from '@drefyn/mdx';
import { describe, expectTypeOf, it } from 'vitest';
import type { NodeContent } from '../../src/index.ts';

function compileOnly(root: MdxRoot): readonly NodeContent[] {
  const accepted: NodeContent = root;
  // @ts-expect-error content is a tree, never a Markdown string
  const text: NodeContent = '# Title';
  // @ts-expect-error a version the code does not know is not this type
  const later: NodeContent = { ...root, astVersion: 0 };
  return [accepted, text, later];
}

describe('NodeContent', () => {
  it('takes an MdxRoot as it is', () => {
    expectTypeOf<MdxRoot>().toExtend<NodeContent>();
    expectTypeOf(compileOnly).toBeFunction();
  });
});
