import type { TenantRef } from '@drefyn/tenancy';
import { organizationId as toOrganizationId, projectId as toProjectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { CODE_LANGUAGES } from './grammars.ts';
import type { CodeLanguage } from './grammars.ts';
import { startExtractThread } from './thread.ts';
import type { ExtractAnswer, ExtractErrorCode, ExtractThread, ThreadRun } from './thread.ts';

export interface ExtractRequest {
  readonly tenant: TenantRef;
  // The file's path in its repository. Logged, so it never holds file text.
  readonly path: string;
  readonly language: CodeLanguage;
  readonly source: string;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface ExtractLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export interface ExtractHostDeps {
  readonly logger: ExtractLogger;
  // Called when terminate could not end a thread. Only ending the process stops it now; the
  // parse host does that and its supervisor starts a new one.
  readonly onStuck: () => void;
  readonly startThread?: () => ExtractThread;
}

export interface ExtractHostStats {
  readonly queued: number;
  readonly running: boolean;
  readonly threadsStarted: number;
}

export interface ExtractHost {
  // Resolves with a refusal for anything about the file or the load, and rejects only on a
  // malformed request, which is our bug and not hostile input. A refused file is never retried
  // here: a second try of a slow file is a second slow file.
  extract(request: ExtractRequest): Promise<ExtractAnswer>;
  stats(): ExtractHostStats;
  close(): Promise<void>;
}

const MAX_MS = 600_000;

const configSchema = z.object({
  timeoutMs: z.int().min(1).max(MAX_MS),
  maxMemoryMb: z.int().min(16).max(8_192),
  killGraceMs: z.int().min(1).max(MAX_MS),
  startTimeoutMs: z.int().min(1).max(MAX_MS),
  maxQueued: z.int().min(1).max(100_000),
  // The digest skips files over 512 KB before they get here; this is the host's own floor.
  maxSourceBytes: z
    .int()
    .min(1)
    .max(64 * 1_048_576),
  // A thread serves many files and tenants. Retiring it caps what a leak can carry between them.
  recycleAfter: z.int().min(1).max(1_000_000),
});

export type ExtractHostConfig = z.infer<typeof configSchema>;

// A real 512 KB TypeScript file takes a few hundred milliseconds; one built to be slow, seconds.
export const DEFAULT_EXTRACT_CONFIG: ExtractHostConfig = {
  timeoutMs: 2_000,
  maxMemoryMb: 512,
  killGraceMs: 2_000,
  startTimeoutMs: 30_000,
  maxQueued: 256,
  maxSourceBytes: 524_288,
  recycleAfter: 1_024,
};

// The brand on a tenant id is only a type, so it is checked again at this edge.
const requestSchema = z.object({
  tenant: z.object({
    organizationId: z.string().transform((value) => toOrganizationId(value)),
    projectId: z.string().transform((value) => toProjectId(value)),
  }),
  path: z.string().min(1).max(4_096),
  language: z.enum(CODE_LANGUAGES),
  source: z.string(),
});

interface Waiting {
  readonly request: ExtractRequest;
  readonly fields: LogFields;
  readonly resolve: (answer: ExtractAnswer) => void;
}

export function createExtractHost(config: ExtractHostConfig, deps: ExtractHostDeps): ExtractHost {
  const settings = configSchema.parse(config);
  const start =
    deps.startThread ??
    (() =>
      startExtractThread({
        timeoutMs: settings.timeoutMs,
        maxMemoryMb: settings.maxMemoryMb,
        killGraceMs: settings.killGraceMs,
        startTimeoutMs: settings.startTimeoutMs,
      }));

  const waiting: Waiting[] = [];
  let thread: { readonly worker: ExtractThread; jobs: number } | undefined;
  let running: Promise<void> | undefined;
  let threadsStarted = 0;
  let closed = false;

  const refuse = (fields: LogFields, error: ExtractErrorCode): ExtractAnswer => {
    deps.logger.warn('code_intel.extract_refused', { ...fields, code: error });
    return { ok: false, error };
  };

  const finish = (item: Waiting, run: ThreadRun) => {
    if (run.answer.ok) {
      const { symbols, routes, partial } = run.answer.value;
      deps.logger.info('code_intel.extracted', {
        ...item.fields,
        symbols: symbols.length,
        routes: routes.length,
        partial,
        workMs: run.workMs,
      });
      item.resolve(run.answer);
    } else {
      item.resolve(refuse({ ...item.fields, workMs: run.workMs }, run.answer.error));
    }
  };

  const runNext = async (item: Waiting) => {
    if (thread === undefined) {
      thread = { worker: start(), jobs: 0 };
      threadsStarted += 1;
    }
    const current = thread;
    const { language, source, path } = item.request;
    const run = await current.worker.run({ language, source, path });
    current.jobs += 1;
    if (run.end !== 'reusable') thread = undefined;
    else if (current.jobs >= settings.recycleAfter) {
      thread = undefined;
      void current.worker.stop();
    }
    finish(item, run);
    if (run.end === 'stuck') {
      closed = true;
      for (const left of waiting.splice(0)) left.resolve(refuse(left.fields, 'code.unavailable'));
      deps.onStuck();
    }
  };

  const pump = () => {
    if (running !== undefined) return;
    const item = waiting.shift();
    if (item === undefined) return;
    running = runNext(item).finally(() => {
      running = undefined;
      pump();
    });
  };

  const extract = (request: ExtractRequest): Promise<ExtractAnswer> => {
    const { tenant, path, language, source } = requestSchema.parse(request);
    const bytes = Buffer.byteLength(source, 'utf8');
    const fields = { ...tenant, path, language, bytes };
    if (closed) return Promise.resolve(refuse(fields, 'code.closed'));
    // Before the queue, so its length also bounds the bytes it can hold.
    if (bytes > settings.maxSourceBytes) return Promise.resolve(refuse(fields, 'code.too_large'));
    if (waiting.length >= settings.maxQueued) {
      return Promise.resolve(refuse(fields, 'code.queue_full'));
    }
    return new Promise((resolve) => {
      waiting.push({ request: { tenant, path, language, source }, fields, resolve });
      pump();
    });
  };

  return {
    extract,
    stats: () => ({ queued: waiting.length, running: running !== undefined, threadsStarted }),
    async close() {
      closed = true;
      for (const left of waiting.splice(0)) left.resolve(refuse(left.fields, 'code.closed'));
      await running;
      const last = thread;
      thread = undefined;
      await last?.worker.stop();
    },
  };
}
