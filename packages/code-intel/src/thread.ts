import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { extractionSchema } from './answer.ts';
import type { CodeLanguage } from './grammars.ts';
import type { FileExtraction } from './types.ts';

export type ExtractErrorCode =
  | 'code.timeout'
  | 'code.out_of_memory'
  | 'code.failed'
  | 'code.unavailable'
  | 'code.queue_full'
  | 'code.too_large'
  | 'code.closed';

export type ExtractAnswer =
  | { readonly ok: true; readonly value: FileExtraction }
  | { readonly ok: false; readonly error: ExtractErrorCode };

export interface ThreadLimits {
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
  readonly killGraceMs: number;
  readonly startTimeoutMs: number;
}

export interface ThreadJob {
  readonly language: CodeLanguage;
  readonly source: string;
  readonly path: string;
}

export interface ThreadRun {
  readonly answer: ExtractAnswer;
  // reusable: the thread can take another file. killed: it is gone. stuck: terminate has not
  // finished, which only native code can cause, so only ending the process will stop it.
  readonly end: 'reusable' | 'killed' | 'stuck';
  readonly workMs: number;
}

export interface ExtractThread {
  run(job: ThreadJob): Promise<ThreadRun>;
  stop(): Promise<unknown>;
}

const YOUNG_GENERATION_MB = 16;
const WORKER_OOM = 'ERR_WORKER_OUT_OF_MEMORY';
const WORKER_URL = new URL('./extract-worker.ts', import.meta.url);

const answerSchema = z.object({ id: z.int(), result: extractionSchema });
const readySchema = z.object({ ready: z.literal(true) });

const refused = (error: ExtractErrorCode): ExtractAnswer => ({ ok: false, error });

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

// A grammar has no time bound of its own and runs in WebAssembly that never yields, so the
// thread is the bound: it is killed at the limit and the next file gets a fresh one.
export function startExtractThread(
  limits: ThreadLimits,
  script: URL = WORKER_URL,
  workerData?: unknown,
): ExtractThread {
  const worker = new Worker(script, {
    env: {},
    argv: [],
    workerData,
    // Crash text can quote the file, so nothing a thread prints reaches our streams.
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxMemoryMb,
      maxYoungGenerationSizeMb: YOUNG_GENERATION_MB,
    },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  worker.unref();

  // The error can quote the file, so only its kind crosses.
  const death = new Promise<ExtractErrorCode>((resolve) => {
    worker.once('error', (error: Error & { code?: string }) => {
      resolve(error.code === WORKER_OOM ? 'code.out_of_memory' : 'code.failed');
    });
    worker.once('exit', () => {
      resolve('code.failed');
    });
  });
  const ready = new Promise<boolean>((resolve) => {
    worker.once('message', (message: unknown) => {
      resolve(readySchema.safeParse(message).success);
    });
  });

  // The answer waits for the kill, so a caller never queues on top of a live stall.
  const kill = async (error: ExtractErrorCode, workMs: number): Promise<ThreadRun> => {
    const grace = deadline(limits.killGraceMs);
    const ended = await Promise.race([worker.terminate(), grace.expired]);
    grace.clear();
    return { answer: refused(error), end: ended === 'expired' ? 'stuck' : 'killed', workMs };
  };

  let lastId = 0;
  const run = async (job: ThreadJob): Promise<ThreadRun> => {
    const start = deadline(limits.startTimeoutMs);
    const started = await Promise.race([death, ready, start.expired]);
    start.clear();
    if (started !== true) return kill('code.unavailable', 0);

    lastId += 1;
    const id = lastId;
    const answer = new Promise<ExtractAnswer | 'unexpected'>((resolve) => {
      worker.once('message', (message: unknown) => {
        const parsed = answerSchema.safeParse(message);
        // A late answer must never land on the next file.
        resolve(
          parsed.success && parsed.data.id === id
            ? { ok: true, value: parsed.data.result }
            : 'unexpected',
        );
      });
    });
    const began = performance.now();
    worker.postMessage({ id, ...job });
    const limit = deadline(limits.timeoutMs);
    const settled = await Promise.race([death, answer, limit.expired]);
    limit.clear();
    const workMs = Math.ceil(performance.now() - began);
    if (settled === 'expired') return kill('code.timeout', workMs);
    if (settled === 'unexpected') return kill('code.failed', workMs);
    if (typeof settled === 'string') return kill(settled, workMs);
    return { answer: settled, end: 'reusable', workMs };
  };

  return { run, stop: () => worker.terminate() };
}
