import { parentPort, workerData } from 'node:worker_threads';
import { parseForStore } from './parse.ts';
import type { Dialect, RenderPolicy } from './types.ts';

interface ParseJob {
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: RenderPolicy;
}

// Checked by zod in the parent before the thread starts.
const { source, dialect, policy } = workerData as ParseJob;
parentPort?.postMessage(parseForStore(source, dialect, policy));
