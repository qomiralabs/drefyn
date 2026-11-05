import { createHash } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';
import { organizationId as toOrganizationId, projectId as toProjectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { parseInputSchema } from './policy.ts';
import { parsePoolConfig, poolConfigSchema } from './pool-config.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import { RECYCLE_AFTER_JOBS, refused, startParseThread } from './thread.ts';
import type { IsolatedPolicy, ParseThread, ThreadAnswer } from './thread.ts';
import type { Dialect, MdxIssueCode, ParseResult } from './types.ts';

export { parsePoolConfig };
export type { IsolatedPolicy, ParsePoolConfig };

export interface ParseRequest extends TenantRef {
  // Where the page lives. Logged, so it never holds page text.
  readonly path: string;
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
}

type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface ParseLogger {
  warn(event: string, fields: LogFields): void;
  // Optional, so a sink that only takes warnings still fits.
  info?(event: string, fields: LogFields): void;
}

export interface ParsePoolDeps {
  readonly logger: ParseLogger;
  readonly now?: () => number;
  readonly startThread?: () => ParseThread;
}

export interface ParsePoolStats {
  readonly threads: number;
  readonly busy: number;
  readonly queued: number;
  readonly stuck: number;
  readonly projects: number;
}

export interface ParsePool {
  // Resolves with a refusal for anything about the page or the load, and rejects only on a
  // malformed request, which is our bug and not bad content. A refused page is never retried
  // here: a second try of a bomb is a second bomb.
  parse(request: ParseRequest): Promise<ParseResult>;
  stats(): ParsePoolStats;
  close(): Promise<void>;
}

// The brand on a tenant id is only a type, so it is checked again at this edge.
const requestSchema = z.object({
  organizationId: z.string().transform((value) => toOrganizationId(value)),
  projectId: z.string().transform((value) => toProjectId(value)),
  path: z.string().min(1).max(4_096),
  policy: z.object({ components: z.set(z.string()) }).loose(),
});

interface Waiting {
  readonly request: ParseRequest;
  readonly fields: LogFields;
  readonly queuedAt: number;
  readonly resolve: (result: ParseResult) => void;
}

interface Project {
  readonly key: string;
  readonly waiting: Waiting[];
  active: number;
  windowStart: number;
  spentMs: number;
}

interface Slot {
  readonly thread: ParseThread;
  jobs: number;
}

export function createParsePool(config: ParsePoolConfig, deps: ParsePoolDeps): ParsePool {
  const settings = poolConfigSchema.parse(config);
  const now = deps.now ?? (() => performance.now());
  const startThread =
    deps.startThread ??
    (() => startParseThread(new URL('./parse-worker.ts', import.meta.url), settings));

  // Insertion order is the turn order: a served project goes to the back.
  const projects = new Map<string, Project>();
  const idle: Slot[] = [];
  const running = new Set<Promise<void>>();
  let busy = 0;
  let stuck = 0;
  let queued = 0;
  let closed = false;
  let lastSweep = now();

  const log = (level: 'info' | 'warn', event: string, fields: LogFields) => {
    try {
      deps.logger[level]?.(event, fields);
    } catch {
      // A log line is never worth a failed parse.
    }
  };

  const report = (fields: LogFields, result: ParseResult) => {
    if (result.ok) {
      log('info', 'mdx.parse_finished', { ...fields, issues: result.value.issues.length });
    } else {
      // Codes only: an issue carries a place and never customer text.
      log('warn', 'mdx.parse_refused', {
        ...fields,
        code: result.error[0]?.code ?? 'mdx.parse_failed',
      });
    }
  };

  const rollWindow = (project: Project) => {
    if (now() - project.windowStart >= settings.projectWindowMs) {
      project.windowStart = now();
      project.spentMs = 0;
    }
  };

  const overBudget = (project: Project) => {
    rollWindow(project);
    return project.spentMs >= settings.projectBudgetMs;
  };

  const refuseWaiting = (project: Project, code: MdxIssueCode) => {
    for (const item of project.waiting.splice(0)) {
      queued -= 1;
      const result = refused(code);
      report(item.fields, result);
      item.resolve(result);
    }
  };

  // Drops what the budget no longer needs, so the map follows live tenants and not all time.
  const sweep = () => {
    if (now() - lastSweep < settings.projectWindowMs) return;
    lastSweep = now();
    for (const project of projects.values()) {
      rollWindow(project);
      if (project.active === 0 && project.waiting.length === 0 && project.spentMs === 0) {
        projects.delete(project.key);
      }
    }
  };

  const takeThread = (): Slot => {
    for (let slot = idle.pop(); slot !== undefined; slot = idle.pop()) {
      if (slot.thread.alive()) return slot;
    }
    return { thread: startThread(), jobs: 0 };
  };

  const release = (slot: Slot, end: ThreadAnswer['end'], fields: LogFields) => {
    if (end === 'stuck') {
      // A replacement would pile threads on top of one that is still running.
      stuck += 1;
      log('warn', 'mdx.parse_thread_stuck', fields);
      void slot.thread.gone.then(() => {
        stuck -= 1;
        pump();
      });
      return;
    }
    if (end === 'killed') {
      log('warn', 'mdx.parse_thread_killed', fields);
      return;
    }
    slot.jobs += 1;
    if (closed || slot.jobs >= RECYCLE_AFTER_JOBS) void slot.thread.stop();
    else idle.push(slot);
  };

  const runJob = async (project: Project, item: Waiting) => {
    const waitedMs = Math.round(now() - item.queuedAt);
    const { source, dialect, policy } = item.request;
    let slot: Slot | undefined;
    let outcome: ThreadAnswer;
    try {
      slot = takeThread();
      outcome = await slot.thread.run({ source, dialect, policy });
    } catch {
      // Whatever the failure said can quote the page, so only the fact crosses.
      outcome = { result: refused('mdx.parse_unavailable'), end: 'killed', workMs: 0 };
    }
    project.active -= 1;
    busy -= 1;
    rollWindow(project);
    project.spentMs += outcome.workMs;
    if (slot !== undefined) release(slot, outcome.end, item.fields);
    report({ ...item.fields, waitedMs, tookMs: outcome.workMs }, outcome.result);
    item.resolve(outcome.result);
    pump();
  };

  const nextProject = (): Project | undefined => {
    for (const project of projects.values()) {
      if (project.waiting.length === 0) continue;
      if (overBudget(project)) refuseWaiting(project, 'mdx.project_limit');
      else if (project.active < settings.projectThreads) return project;
    }
    return undefined;
  };

  function pump() {
    if (stuck >= settings.threads) {
      for (const project of projects.values()) refuseWaiting(project, 'mdx.parse_unavailable');
      return;
    }
    while (busy + stuck < settings.threads) {
      const project = nextProject();
      const item = project?.waiting.shift();
      if (project === undefined || item === undefined) return;
      queued -= 1;
      busy += 1;
      project.active += 1;
      projects.delete(project.key);
      projects.set(project.key, project);
      const job: Promise<void> = runJob(project, item).finally(() => {
        running.delete(job);
      });
      running.add(job);
    }
  }

  const projectOf = (tenant: TenantRef): Project => {
    const key = `${tenant.organizationId}:${tenant.projectId}`;
    const known = projects.get(key);
    if (known !== undefined) return known;
    const project = { key, waiting: [], active: 0, windowStart: now(), spentMs: 0 };
    projects.set(key, project);
    return project;
  };

  const parse = async (request: ParseRequest): Promise<ParseResult> => {
    const tenant = requestSchema.parse(request);
    parseInputSchema.parse(request);
    const { source, path, policy } = request;
    const bytes = Buffer.byteLength(source, 'utf8');
    const { organizationId, projectId } = tenant;
    const base = { organizationId, projectId, path, bytes };
    const instant = (code: MdxIssueCode, fields: LogFields) => {
      const result = refused(code);
      report(fields, result);
      return result;
    };

    // Before the queue, so its length also bounds the bytes it can hold.
    if (bytes > policy.limits.maxBytes) return instant('mdx.too_large', base);
    const fields = { ...base, sha256: createHash('sha256').update(source).digest('hex') };
    if (closed || stuck >= settings.threads) return instant('mdx.parse_unavailable', fields);

    sweep();
    const project = projectOf(tenant);
    if (overBudget(project) || project.waiting.length >= settings.maxQueuedPerProject) {
      return instant('mdx.project_limit', fields);
    }
    if (queued >= settings.maxQueued) return instant('mdx.queue_full', fields);

    return new Promise((resolve) => {
      project.waiting.push({ request, fields, queuedAt: now(), resolve });
      queued += 1;
      pump();
    });
  };

  return {
    parse,
    stats: () => ({
      threads: idle.length + busy + stuck,
      busy,
      queued,
      stuck,
      projects: projects.size,
    }),
    async close() {
      closed = true;
      for (const project of projects.values()) refuseWaiting(project, 'mdx.parse_unavailable');
      await Promise.all(running);
      await Promise.all(idle.splice(0).map(({ thread }) => thread.stop()));
    },
  };
}
