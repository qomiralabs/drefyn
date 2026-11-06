import { z } from 'zod';
import { AST_VERSION } from './types.ts';

// Only the outer shape: the walks behind this take any node, and depth is checked by a walk
// that keeps its own stack.
export const rootSchema = z.looseObject({
  type: z.literal('root'),
  astVersion: z.literal(AST_VERSION),
  dialect: z.enum(['mdx', 'md']),
  eol: z.enum(['lf', 'crlf']),
  children: z.array(z.looseObject({ type: z.string() })),
  tail: z.string(),
  tailOf: z.string(),
});
