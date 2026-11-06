import { z } from 'zod';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import type { JobResult } from './result.ts';
import type { MdxRoot, ParseResult, PrintResult } from './types.ts';

const blockBytes = z.looseObject({
  source: z.looseObject({ raw: z.string(), gapBefore: z.string() }),
});

// What a parser tree says the page was. It costs one pass over the top level blocks, and a host
// that has been taken over can no longer hand back a tree that disagrees with the page.
export function bytesOfTree(root: MdxRoot): string | undefined {
  let bytes = '';
  for (const block of root.children) {
    const parsed = blockBytes.safeParse(block);
    if (!parsed.success) return undefined;
    bytes += parsed.data.source.gapBefore + parsed.data.source.raw;
  }
  return bytes + root.tail;
}

const parsedSchema = z.looseObject({ ast: rootSchema });
const printedSchema = z.looseObject({ text: z.string(), ast: rootSchema });

// A caller stores what these hand back, so a malformed answer must not look like a success.
export function checkParsed(answer: JobResult, source: string): ParseResult {
  if (!answer.ok) return answer;
  const parsed = parsedSchema.safeParse(answer.value);
  if (!parsed.success) return refused('mdx.parse_failed');
  const tree = parsed.data.ast as unknown as MdxRoot;
  return bytesOfTree(tree) === source ? (answer as ParseResult) : refused('mdx.parse_failed');
}

export function checkPrinted(answer: JobResult): PrintResult {
  if (!answer.ok) return answer;
  const printed = printedSchema.safeParse(answer.value);
  if (!printed.success) return refused('mdx.parse_failed');
  const tree = printed.data.ast as unknown as MdxRoot;
  return bytesOfTree(tree) === printed.data.text
    ? (answer as PrintResult)
    : refused('mdx.parse_failed');
}
