import { z } from 'zod';
import { merge3 } from './merge3.ts';
import { printAndReparse } from './print-job.ts';
import { refused } from './result.ts';
import type { MergeJob } from './thread.ts';
import type { MdxRoot, MergeAnswer, MergeOutcome } from './types.ts';

const treesSchema = z.object({ base: z.unknown(), ours: z.unknown(), theirs: z.unknown() });

// Every block can be sound and the page still not be: a fence left open at the end of a file
// swallows what a move put after it, and two sides can each add one import of a name. Clean has
// to mean storable, or a sync would stop on a refusal nobody can resolve. Blocks say nothing
// here, as the fault is between them, so the record names the whole page.
function provenClean(outcome: MergeOutcome, policy: MergeJob['policy']): MergeOutcome {
  if (outcome.kind !== 'clean' || printAndReparse(outcome.merged, policy).ok) return outcome;
  const conflict = { baseIndex: null, ours: null, theirs: null, reason: 'both_changed' } as const;
  return { kind: 'conflict', partial: outcome.merged, conflicts: [conflict] };
}

// Runs in a thread that can be killed, for the reason printing does: a merge prints and parses,
// and neither can be bounded from inside. A clean result still goes through client.print, so
// one rule covers every writer and what gets stored is what that hands back.
export function mergePage({ trees, policy, maxBlocks }: MergeJob): MergeAnswer {
  try {
    const input = treesSchema.safeParse(JSON.parse(trees));
    if (!input.success) return refused('mdx.block_not_printable');
    const { base, ours, theirs } = input.data as Readonly<Record<string, MdxRoot>> & {
      base: MdxRoot;
      ours: MdxRoot;
      theirs: MdxRoot;
    };
    const result = merge3(base, ours, theirs, { maxBlocks, policy });
    if (!result.ok) return result;
    return { ok: true, value: { outcome: provenClean(result.value, policy), issues: [] } };
  } catch {
    // The error can quote the tree, so only the fact crosses.
    return refused('mdx.block_not_printable');
  }
}
