import { keptItsBytes, meaningOf } from './meaning.ts';
import { parseForStore } from './parse.ts';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import { serialize } from './serialize.ts';
import type { PrintJob } from './thread.ts';
import type { MdxRoot, PrintResult } from './types.ts';

const elapsed = (from: number, to: number) => Math.round((to - from) * 10) / 10;

export function printAndReparse(
  root: MdxRoot,
  policy: PrintJob['policy'],
  decodeMs: number,
): PrintResult {
  const started = performance.now();
  const text = serialize(root, policy.limits);
  const printed = performance.now();
  const reparsed = parseForStore(text, root.dialect, policy);
  const parsedAt = performance.now();
  if (!reparsed.ok) return reparsed;
  const { ast, issues } = reparsed.value;
  const same =
    meaningOf(ast.children) === meaningOf(root.children) &&
    keptItsBytes(root.children, ast.children);
  const timing = {
    decodeMs,
    printMs: elapsed(started, printed),
    reparseMs: elapsed(printed, parsedAt),
    compareMs: elapsed(parsedAt, performance.now()),
  };
  return same
    ? { ok: true, value: { text, ast, issues, timing } }
    : refused('mdx.print_changed_meaning');
}

// Runs in a thread that can be killed: the printer's cost lives in a third party solver that
// retries per mistake and never yields, so nothing inside it can be bounded either. The reparse
// is the check on what no list of escapes can cover. If the bytes do not mean what the tree
// says, nothing leaves here. The policy applies as well, since it has only ever run on a parse.
export function printPage({ tree, policy }: PrintJob): PrintResult {
  try {
    const started = performance.now();
    const root = rootSchema.safeParse(JSON.parse(tree));
    if (!root.success) return refused('mdx.block_not_printable');
    const decodeMs = elapsed(started, performance.now());
    return printAndReparse(root.data as unknown as MdxRoot, policy, decodeMs);
  } catch {
    // A malformed tree has many ways to throw, and each one here would cost a thread start.
    // The error can quote the tree, so only the fact crosses.
    return refused('mdx.block_not_printable');
  }
}
