import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { refused, resultSchema } from './result.ts';
import type { Dialect, MdxIssueCode, ParseResult, RenderPolicy } from './types.ts';

export interface ThreadLimits {
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
  readonly killGraceMs: number;
  readonly startTimeoutMs?: number;
}

export type IsolatedPolicy = Omit<RenderPolicy, 'components'> & {
  // Crosses to the thread by structured clone, so it has to be plain data.
  readonly components: ReadonlySet<string>;
};

export interface ThreadJob {
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
}

export interface ThreadAnswer {
  readonly result: ParseResult;
  // reusable: the thread can take another job. killed: it is gone. stuck: terminate has not
  // finished, which only native code can cause, so only ending the process will stop it.
  readonly end: 'reusable' | 'killed' | 'stuck';
  // Time the page held the thread. A slow thread start is the host's cost, not the project's.
  readonly workMs: number;
}

export interface ParseThread {
  run(job: ThreadJob): Promise<ThreadAnswer>;
  alive(): boolean;
  stop(): Promise<unknown>;
}

// A thread serves many tenants. Retiring it caps what a parser leak can carry between them.
export const RECYCLE_AFTER_JOBS = 256;

// Young generation stays small so the cap is mostly the old generation it names.
const YOUNG_GENERATION_MB = 16;
// A module load, not a parse, so a slow start on a loaded host does not bill the page.
const START_TIMEOUT_MS = 30_000;
const WORKER_OOM = 'ERR_WORKER_OUT_OF_MEMORY';

const answerSchema = z.object({ id: z.int(), result: resultSchema });
const readySchema = z.object({ ready: z.literal(true) });

function deadline(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => {
      resolve('expired');
    }, ms);
  });
  return {
    expired,
    clear() {
      clearTimeout(timer);
    },
  };
}

// The parser cannot be bounded from inside: its cost lives in third party resolvers and
// regular expressions that never yield. A thread can be killed, and that is the only hard
// limit on time or memory a customer page has.
export function startParseThread(script: URL, limits: ThreadLimits): ParseThread {
  const worker = new Worker(script, {
    env: {},
    argv: [],
    // No execArgv here: an empty list would drop --permission for the thread.
    // Crash text can quote the page, so nothing a thread prints reaches our streams.
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxMemoryMb,
      maxYoungGenerationSizeMb: YOUNG_GENERATION_MB,
    },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  // An idle pool must not hold the process open. A running job has its own timer.
  worker.unref();

  let exited = false;
  // The error can quote the page, so only its kind crosses.
  const death = new Promise<MdxIssueCode>((resolve) => {
    worker.once('error', (error: Error & { code?: string }) => {
      resolve(error.code === WORKER_OOM ? 'mdx.out_of_memory' : 'mdx.parse_failed');
    });
    worker.once('exit', () => {
      exited = true;
      resolve('mdx.parse_failed');
    });
  });
  const ready = new Promise<boolean>((resolve) => {
    worker.once('message', (message: unknown) => {
      resolve(readySchema.safeParse(message).success);
    });
  });

  // The answer waits for the kill, so a caller never queues on top of a live stall.
  const kill = async (result: ParseResult, workMs = 0): Promise<ThreadAnswer> => {
    const grace = deadline(limits.killGraceMs);
    const ended = await Promise.race([worker.terminate(), grace.expired]);
    grace.clear();
    return { result, end: ended === 'expired' ? 'stuck' : 'killed', workMs };
  };

  let lastId = 0;
  const run = async (job: ThreadJob): Promise<ThreadAnswer> => {
    const start = deadline(limits.startTimeoutMs ?? START_TIMEOUT_MS);
    const started = await Promise.race([death, ready, start.expired]);
    start.clear();
    if (started !== true) return kill(refused('mdx.parse_unavailable'));

    lastId += 1;
    const id = lastId;
    const answer = new Promise<ParseResult | 'unexpected'>((resolve) => {
      worker.once('message', (message: unknown) => {
        const parsed = answerSchema.safeParse(message);
        // A late answer must never land on the next tenant's page.
        resolve(parsed.success && parsed.data.id === id ? parsed.data.result : 'unexpected');
      });
    });
    const began = performance.now();
    worker.postMessage({ id, job });
    const limit = deadline(limits.timeoutMs);
    const settled = await Promise.race([death, answer, limit.expired]);
    limit.clear();
    const workMs = Math.ceil(performance.now() - began);
    if (settled === 'expired') return kill(refused('mdx.parse_timeout'), workMs);
    if (settled === 'unexpected') return kill(refused('mdx.parse_failed'), workMs);
    if (typeof settled === 'string') return kill(refused(settled), workMs);
    return { result: settled, end: 'reusable', workMs };
  };

  return {
    run,
    alive: () => !exited,
    stop: () => worker.terminate(),
  };
}
