import { z } from 'zod';
import { meaningOf } from './meaning.ts';
import { parseForStore } from './parse.ts';
import { MdxPrintError } from './print.ts';
import { refused } from './result.ts';
import { serialize } from './serialize.ts';
import type { PrintJob } from './thread.ts';
import { AST_VERSION } from './types.ts';
import type { MdxRoot, PrintResult } from './types.ts';

// Only the outer shape: the walks behind this take any node, and depth is checked by a walk
// that keeps its own stack.
const rootSchema = z.looseObject({
  type: z.literal('root'),
  astVersion: z.literal(AST_VERSION),
  dialect: z.enum(['mdx', 'md']),
  eol: z.enum(['lf', 'crlf']),
  children: z.array(z.looseObject({ type: z.string() })),
  tail: z.string(),
  tailOf: z.string(),
});

function readRoot(tree: string): MdxRoot | undefined {
  try {
    const root = rootSchema.safeParse(JSON.parse(tree));
    return root.success ? (root.data as unknown as MdxRoot) : undefined;
  } catch {
    // The error can quote the tree, so only the fact crosses.
    return undefined;
  }
}

function printed(root: MdxRoot, limits: PrintJob['policy']['limits']): string | undefined {
  try {
    return serialize(root, limits);
  } catch (error) {
    if (error instanceof MdxPrintError) return undefined;
    throw error;
  }
}

// Runs in a thread that can be killed: the printer's cost lives in a third party solver that
// retries per mistake and never yields, so nothing inside it can be bounded either. The reparse
// is the check on what no list of escapes can cover. If the bytes do not mean what the tree
// says, nothing leaves here. The policy applies as well, since it has only ever run on a parse.
export function printPage({ tree, policy }: PrintJob): PrintResult {
  const root = readRoot(tree);
  if (root === undefined) return refused('mdx.block_not_printable');
  const text = printed(root, policy.limits);
  if (text === undefined) return refused('mdx.block_not_printable');
  const reparsed = parseForStore(text, root.dialect, policy);
  if (!reparsed.ok) return reparsed;
  const { ast, issues } = reparsed.value;
  if (meaningOf(ast.children) !== meaningOf(root.children)) {
    return refused('mdx.print_changed_meaning');
  }
  return { ok: true, value: { text, ast, issues } };
}
