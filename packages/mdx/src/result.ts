import { z } from 'zod';
import type { MdxIssue, MdxIssueCode, MergeAnswer, ParseResult, PrintResult } from './types.ts';

export type JobResult = ParseResult | PrintResult | MergeAnswer;

export interface Refused {
  readonly ok: false;
  readonly error: readonly MdxIssue[];
}

export const refused = (code: MdxIssueCode): Refused => {
  const issue: MdxIssue = { code, severity: 'error', line: 1, column: 1 };
  return { ok: false, error: [issue] };
};

const issueSchema = z.object({
  code: z.string().startsWith('mdx.'),
  severity: z.enum(['error', 'warning']),
  line: z.int(),
  column: z.int(),
});

// The tree is not walked: that costs a parse, and the page's own limits already bound it. The
// outer shape has to hold, because an answer comes from where hostile pages run.
const shapeSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ issues: z.array(z.unknown()) }) }),
  z.object({ ok: z.literal(false), error: z.array(z.unknown()) }),
]);

export const resultSchema = z.custom<JobResult>((value) => shapeSchema.safeParse(value).success);

// For an answer that crossed the network, where issues are read by the caller too.
export const wireResultSchema = z.custom<JobResult>((value) => {
  const shape = shapeSchema.safeParse(value);
  if (!shape.success) return false;
  const issues = shape.data.ok ? shape.data.value.issues : shape.data.error;
  return z.array(issueSchema).safeParse(issues).success;
});
