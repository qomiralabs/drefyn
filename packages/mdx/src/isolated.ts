import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { parseInputSchema } from './policy.ts';
import type { Dialect, MdxIssue, MdxIssueCode, ParseResult, RenderPolicy } from './types.ts';

// The parser cannot be bounded from inside: its cost lives in third party resolvers and
// regular expressions that never yield. A thread can be killed, and that is the only hard
// limit on time or memory a customer page has.
export interface IsolationLimits {
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
}

export type IsolatedPolicy = Omit<RenderPolicy, 'components'> & {
  // Crosses to the thread by structured clone, so it has to be plain data.
  readonly components: ReadonlySet<string>;
};

const limitsSchema = z.object({
  timeoutMs: z.int().min(1).max(600_000),
  maxMemoryMb: z.int().min(16).max(8_192),
});

// Young generation stays small so the cap is mostly the old generation it names.
const YOUNG_GENERATION_MB = 16;
const WORKER_OOM = 'ERR_WORKER_OUT_OF_MEMORY';

const refused = (code: MdxIssueCode): ParseResult => {
  const issue: MdxIssue = { code, severity: 'error', line: 1, column: 1 };
  return { ok: false, error: [issue] };
};

export function runIsolated(
  script: URL,
  workerData: unknown,
  limits: IsolationLimits,
): Promise<ParseResult> {
  const { timeoutMs, maxMemoryMb } = limitsSchema.parse(limits);
  return new Promise((resolve) => {
    const worker = new Worker(script, {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: maxMemoryMb,
        maxYoungGenerationSizeMb: YOUNG_GENERATION_MB,
      },
    });
    let settled = false;
    const settle = (result: ParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The answer waits for the kill, so a caller never queues on top of a live stall.
      void worker.terminate().then(() => {
        resolve(result);
      });
    };
    const timer = setTimeout(() => {
      settle(refused('mdx.parse_timeout'));
    }, timeoutMs);
    worker.once('message', (result: ParseResult) => {
      settle(result);
    });
    // The error can quote the page, so only its kind crosses.
    worker.once('error', (error: Error & { code?: string }) => {
      settle(refused(error.code === WORKER_OOM ? 'mdx.out_of_memory' : 'mdx.parse_failed'));
    });
    worker.once('exit', () => {
      settle(refused('mdx.parse_failed'));
    });
  });
}

export async function parseIsolated(
  source: string,
  dialect: Dialect,
  policy: IsolatedPolicy,
  limits: IsolationLimits,
): Promise<ParseResult> {
  parseInputSchema.parse({ source, dialect, policy });
  const script = new URL('./parse-worker.ts', import.meta.url);
  return runIsolated(script, { source, dialect, policy }, limits);
}
