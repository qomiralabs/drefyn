import { z } from 'zod';
import { unexplainedTokens } from './merge-count.ts';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import type { JobResult } from './result.ts';
import type { MdxRoot, MergeAnswer, ParseResult, PrintResult, ReaderPage } from './types.ts';

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
const time = z.number().min(0);
// The pool checks this too, ahead of a log line, as the thread that sends it runs hostile pages.
export const timingSchema = z.object({
  decodeMs: time,
  printMs: time,
  reparseMs: time,
  compareMs: time,
  waitedMs: time.optional(),
  threadMs: time.optional(),
});
const printedSchema = z.looseObject({
  text: z.string(),
  ast: rootSchema,
  timing: timingSchema.optional(),
});

const unitSchema = z.strictObject({
  heading: z.strictObject({ depth: z.int().min(1).max(6), text: z.string() }).optional(),
  text: z.string(),
});
const readerSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), units: z.array(unitSchema) }),
  z.strictObject({ state: z.literal('not_renderable') }),
]);

// A render keeps no more text than the page holds, plus a back reference for each footnote.
export const maxReaderChars = (maxBytes: number) => maxBytes * 2 + 65_536;

export interface ReaderAsk {
  readonly asked: boolean;
  readonly maxBytes: number;
}

// Reader text goes on to search, the assistant and MCP, and it comes from where hostile pages
// run. A heading's text is its unit's text, so it is checked and not counted twice.
function readerHolds(reader: unknown, maxBytes: number): reader is ReaderPage {
  const checked = readerSchema.safeParse(reader);
  if (!checked.success) return false;
  if (checked.data.state === 'not_renderable') return true;
  let chars = 0;
  for (const { heading, text } of checked.data.units) {
    if (heading !== undefined && heading.text !== text) return false;
    chars += text.length;
  }
  return chars <= maxReaderChars(maxBytes);
}

// Text the caller did not ask for goes, so nothing unchecked can be stored by mistake.
function withReader<T extends ParseResult | PrintResult>(answer: T, ask: ReaderAsk): T {
  if (!answer.ok) return answer;
  const { reader, ...value } = answer.value;
  if (!ask.asked) return reader === undefined ? answer : { ...answer, value };
  return readerHolds(reader, ask.maxBytes) ? answer : (refused('mdx.parse_failed') as T);
}

const NOT_ASKED: ReaderAsk = { asked: false, maxBytes: 0 };

// A caller stores what these hand back, so a malformed answer must not look like a success.
export function checkParsed(answer: JobResult, source: string, ask = NOT_ASKED): ParseResult {
  if (!answer.ok) return answer;
  const parsed = parsedSchema.safeParse(answer.value);
  if (!parsed.success) return refused('mdx.parse_failed');
  const tree = parsed.data.ast as unknown as MdxRoot;
  if (bytesOfTree(tree) !== source) return refused('mdx.parse_failed');
  return withReader(answer as ParseResult, ask);
}

export function checkPrinted(answer: JobResult, ask = NOT_ASKED): PrintResult {
  if (!answer.ok) return answer;
  const printed = printedSchema.safeParse(answer.value);
  if (!printed.success) return refused('mdx.parse_failed');
  const tree = printed.data.ast as unknown as MdxRoot;
  if (bytesOfTree(tree) !== printed.data.text) return refused('mdx.parse_failed');
  return withReader(answer as PrintResult, ask);
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
