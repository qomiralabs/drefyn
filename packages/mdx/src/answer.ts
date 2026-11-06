import { z } from 'zod';
import { unexplainedTokens } from './merge-count.ts';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import type { JobResult } from './result.ts';
import type { MdxRoot, MergeAnswer, ParseResult, PrintResult } from './types.ts';

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

const blockSchema = z.looseObject({ type: z.string() });

const conflictSchema = z.object({
  baseIndex: z.int().nullable(),
  ours: blockSchema.nullable(),
  theirs: blockSchema.nullable(),
  reason: z.enum([
    'both_changed',
    'delete_vs_edit',
    'both_inserted',
    'move_vs_edit',
    'unexplained_change',
  ]),
});

const mergedSchema = z.looseObject({
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('clean'), merged: rootSchema }),
    z.object({
      kind: z.literal('conflict'),
      partial: rootSchema,
      conflicts: z.array(conflictSchema).min(1),
    }),
  ]),
});

export interface MergedTrees {
  readonly base: MdxRoot;
  readonly ours: MdxRoot;
  readonly theirs: MdxRoot;
}

// A conflict read as clean would be a silent overwrite, so the answer has to prove its shape. The
// host says clean by its own count, and this repeats it on the trees sent, so a host that has been
// taken over cannot report clean over a dropped block.
export function checkMerged(answer: JobResult, { base, ours, theirs }: MergedTrees): MergeAnswer {
  if (!answer.ok) return answer;
  const merged = mergedSchema.safeParse(answer.value);
  if (!merged.success) return refused('mdx.parse_failed');
  const { outcome } = merged.data;
  if (outcome.kind !== 'clean') return answer as MergeAnswer;
  const tree = outcome.merged as unknown as MdxRoot;
  return unexplainedTokens(base, ours, theirs, tree) === 0
    ? (answer as MergeAnswer)
    : refused('mdx.parse_failed');
}
