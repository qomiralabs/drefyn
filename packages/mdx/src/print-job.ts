import { keptItsBytes, meaningOf } from './meaning.ts';
import { parseForStore } from './parse.ts';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import { serialize } from './serialize.ts';
import type { PrintJob } from './thread.ts';
import type { MdxRoot, PrintResult } from './types.ts';

function printAndReparse(root: MdxRoot, policy: PrintJob['policy']): PrintResult {
  const text = serialize(root, policy.limits);
  const reparsed = parseForStore(text, root.dialect, policy);
  if (!reparsed.ok) return reparsed;
  const { ast, issues } = reparsed.value;
  const same =
    meaningOf(ast.children) === meaningOf(root.children) &&
    keptItsBytes(root.children, ast.children);
  return same ? { ok: true, value: { text, ast, issues } } : refused('mdx.print_changed_meaning');
}

// Runs in a thread that can be killed: the printer's cost lives in a third party solver that
// retries per mistake and never yields, so nothing inside it can be bounded either. The reparse
// is the check on what no list of escapes can cover. If the bytes do not mean what the tree
// says, nothing leaves here. The policy applies as well, since it has only ever run on a parse.
export function printPage({ tree, policy }: PrintJob): PrintResult {
  try {
    const root = rootSchema.safeParse(JSON.parse(tree));
    if (!root.success) return refused('mdx.block_not_printable');
    return printAndReparse(root.data as unknown as MdxRoot, policy);
  } catch {
    // A malformed tree has many ways to throw, and each one here would cost a thread start.
    // The error can quote the tree, so only the fact crosses.
    return refused('mdx.block_not_printable');
  }
}
