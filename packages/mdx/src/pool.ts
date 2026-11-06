import { createHash } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';
import { organizationId as toOrganizationId, projectId as toProjectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { parseInputSchema } from './policy.ts';
import { poolConfigSchema } from './pool-config.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import { refused } from './result.ts';
import type { JobResult } from './result.ts';
import { RECYCLE_AFTER_JOBS, startParseThread } from './thread.ts';
import type { IsolatedPolicy, ParseThread, ThreadAnswer, ThreadJob } from './thread.ts';
import type { Dialect, MdxIssueCode, ParseResult, PrintResult } from './types.ts';
import { maxTreeBytes } from './wire.ts';

export interface ParseRequest {
  readonly tenant: TenantRef;
  // Where the page lives. Logged, so it never holds page text.
  readonly path: string;
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
}

export interface PrintRequest {
  readonly tenant: TenantRef;
  // Logged, so it never holds page text.
  readonly path: string;
  // A stored tree as JSON text.
  readonly tree: string;
  readonly policy: IsolatedPolicy;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface ParseLogger {
  warn(event: string, fields: LogFields): void;
  // Optional, so a sink that only takes warnings still fits.
  info?(event: string, fields: LogFields): void;
}

export interface ParsePoolDeps {
  readonly logger: ParseLogger;
  // Called when terminate could not end a thread. Only ending the process stops it now, and
  // the host does exactly that, so the pool keeps no state for a thread it cannot end.
  readonly onStuck: () => void;
  readonly now?: () => number;
  readonly startThread?: () => ParseThread;
}

export interface ParsePoolStats {
  readonly threads: number;
  readonly busy: number;
  readonly queued: number;
  readonly organizations: number;
  readonly projects: number;
}

export interface ParsePool {
  // Resolves with a refusal for anything about the page or the load, and rejects only on a
  // malformed request, which is our bug and not bad content. A refused page is never retried
  // here: a second try of a bomb is a second bomb.
  parse(request: ParseRequest): Promise<ParseResult>;
  // The same queues, budgets and kill, as a printer has no bound of its own either.
  print(request: PrintRequest): Promise<PrintResult>;
  stats(): ParsePoolStats;
  close(): Promise<void>;
}

// The brand on a tenant id is only a type, so it is checked again at this edge.
const requestSchema = z.object({
  tenant: z.object({
    organizationId: z.string().transform((value) => toOrganizationId(value)),
    projectId: z.string().transform((value) => toProjectId(value)),
  }),
  path: z.string().min(1).max(4_096),
  policy: z.object({ components: z.set(z.string()) }).loose(),
});

interface Waiting {
  readonly job: ThreadJob;
  readonly fields: LogFields;
  readonly queuedAt: number;
  readonly resolve: (result: JobResult) => void;
}

interface Budget {
  active: number;
  windowStart: number;
  spentMs: number;
}

interface Project extends Budget {
  readonly key: string;
  readonly waiting: Waiting[];
}

interface Organization extends Budget {
  readonly key: string;
  // Insertion order is the turn order here too.
  readonly projects: Map<string, Project>;
  queued: number;
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

  // Insertion order is the turn order: a served organization goes to the back, so a tenant
  // gets the same turns however many projects it makes.
  const organizations = new Map<string, Organization>();
  const idle: Slot[] = [];
  const running = new Set<Promise<void>>();
  let busy = 0;
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

  const report = (fields: LogFields, result: JobResult) => {
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

  const rollWindow = (budget: Budget) => {
    if (now() - budget.windowStart >= settings.windowMs) {
      budget.windowStart = now();
      budget.spentMs = 0;
    }
  };

  const spent = (budget: Budget, limitMs: number) => {
    rollWindow(budget);
    return budget.spentMs >= limitMs;
  };

  const refuseProject = (organization: Organization, project: Project, code: MdxIssueCode) => {
    for (const item of project.waiting.splice(0)) {
      queued -= 1;
      organization.queued -= 1;
      const result = refused(code);
      report(item.fields, result);
      item.resolve(result);
    }
  };

  const refuseOrganization = (organization: Organization, code: MdxIssueCode) => {
    for (const project of organization.projects.values()) {
      refuseProject(organization, project, code);
    }
  };

  // Drops what the budgets no longer need, so the maps follow live tenants and not all time.
  const sweep = () => {
    if (now() - lastSweep < settings.windowMs) return;
    lastSweep = now();
    const finished = (budget: Budget) => {
      rollWindow(budget);
      return budget.active === 0 && budget.spentMs === 0;
    };
    for (const organization of organizations.values()) {
      for (const project of organization.projects.values()) {
        if (finished(project) && project.waiting.length === 0) {
          organization.projects.delete(project.key);
        }
      }
      if (finished(organization) && organization.projects.size === 0) {
        organizations.delete(organization.key);
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
      log('warn', 'mdx.parse_thread_stuck', fields);
      deps.onStuck();
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

  const runJob = async (organization: Organization, project: Project, item: Waiting) => {
    const waitedMs = Math.round(now() - item.queuedAt);
    let slot: Slot | undefined;
    let outcome: ThreadAnswer;
    try {
      slot = takeThread();
      outcome = await slot.thread.run(item.job);
    } catch {
      // Whatever the failure said can quote the page, so only the fact crosses.
      outcome = { result: refused('mdx.parse_unavailable'), end: 'killed', workMs: 0 };
    }
    busy -= 1;
    for (const budget of [organization, project]) {
      budget.active -= 1;
      rollWindow(budget);
      budget.spentMs += outcome.workMs;
    }
    if (slot !== undefined) release(slot, outcome.end, item.fields);
    report({ ...item.fields, waitedMs, tookMs: outcome.workMs }, outcome.result);
    item.resolve(outcome.result);
    pump();
  };

  const nextProject = (organization: Organization): Project | undefined => {
    for (const project of organization.projects.values()) {
      if (project.waiting.length === 0) continue;
      if (spent(project, settings.projectBudgetMs)) {
        refuseProject(organization, project, 'mdx.project_limit');
      } else if (project.active < settings.projectThreads) {
        return project;
      }
    }
    return undefined;
  };

  const nextJob = (): readonly [Organization, Project] | undefined => {
    for (const organization of organizations.values()) {
      if (organization.queued === 0) continue;
      if (spent(organization, settings.orgBudgetMs)) {
        refuseOrganization(organization, 'mdx.organization_limit');
      } else if (organization.active < settings.orgThreads) {
        const project = nextProject(organization);
        if (project !== undefined) return [organization, project];
      }
    }
    return undefined;
  };

  function pump() {
    while (busy < settings.threads) {
      const next = nextJob();
      if (next === undefined) return;
      const [organization, project] = next;
      const item = project.waiting.shift();
      if (item === undefined) return;
      queued -= 1;
      organization.queued -= 1;
      busy += 1;
      organization.active += 1;
      project.active += 1;
      organizations.delete(organization.key);
      organizations.set(organization.key, organization);
      organization.projects.delete(project.key);
      organization.projects.set(project.key, project);
      const job: Promise<void> = runJob(organization, project, item).finally(() => {
        running.delete(job);
      });
      running.add(job);
    }
  }

  const organizationOf = (key: string): Organization => {
    const known = organizations.get(key);
    if (known !== undefined) return known;
    const organization = {
      key,
      projects: new Map<string, Project>(),
      queued: 0,
      active: 0,
      windowStart: now(),
      spentMs: 0,
    };
    organizations.set(key, organization);
    return organization;
  };

  const projectOf = (organization: Organization, key: string): Project => {
    const known = organization.projects.get(key);
    if (known !== undefined) return known;
    const project = { key, waiting: [], active: 0, windowStart: now(), spentMs: 0 };
    organization.projects.set(key, project);
    return project;
  };

  const instant = (code: MdxIssueCode, fields: LogFields) => {
    const result = refused(code);
    report(fields, result);
    return result;
  };

  const enqueue = (
    job: ThreadJob,
    text: string,
    { organizationId, projectId }: TenantRef,
    base: LogFields,
  ): Promise<JobResult> | JobResult => {
    const fields = { ...base, sha256: createHash('sha256').update(text).digest('hex') };
    if (closed) return instant('mdx.parse_unavailable', fields);

    sweep();
    const organization = organizationOf(organizationId);
    if (spent(organization, settings.orgBudgetMs)) {
      return instant('mdx.organization_limit', fields);
    }
    if (organization.queued >= settings.maxQueuedPerOrg) {
      return instant('mdx.organization_limit', fields);
    }
    const project = projectOf(organization, projectId);
    if (
      spent(project, settings.projectBudgetMs) ||
      project.waiting.length >= settings.maxQueuedPerProject
    ) {
      return instant('mdx.project_limit', fields);
    }
    if (queued >= settings.maxQueued) return instant('mdx.queue_full', fields);

    return new Promise((resolve) => {
      project.waiting.push({ job, fields, queuedAt: now(), resolve });
      queued += 1;
      organization.queued += 1;
      pump();
    });
  };

  const parse = async (request: ParseRequest): Promise<ParseResult> => {
    const { tenant } = requestSchema.parse(request);
    parseInputSchema.parse(request);
    const { source, dialect, path, policy } = request;
    const { organizationId, projectId } = tenant;
    const bytes = Buffer.byteLength(source, 'utf8');
    const base = { organizationId, projectId, path, bytes };
    // Before the queue, so its length also bounds the bytes it can hold.
    if (bytes > policy.limits.maxBytes) return instant('mdx.too_large', base);
    const job = { source, dialect, policy };
    return await enqueue(job, source, tenant, base);
  };

  const print = async (request: PrintRequest): Promise<PrintResult> => {
    const { tenant } = requestSchema.parse(request);
    parseInputSchema.shape.policy.parse(request.policy);
    const { tree, path, policy } = request;
    const { organizationId, projectId } = tenant;
    const bytes = Buffer.byteLength(tree, 'utf8');
    const base = { organizationId, projectId, path, bytes };
    if (bytes > maxTreeBytes(policy.limits.maxBytes)) return instant('mdx.too_large', base);
    return (await enqueue({ tree, policy }, tree, tenant, base)) as PrintResult;
  };

  const allProjects = () =>
    [...organizations.values()].reduce((sum, { projects }) => sum + projects.size, 0);

  return {
    parse,
    print,
    stats: () => ({
      threads: idle.length + busy,
      busy,
      queued,
      organizations: organizations.size,
      projects: allProjects(),
    }),
    async close() {
      closed = true;
      for (const organization of organizations.values()) {
        refuseOrganization(organization, 'mdx.parse_unavailable');
      }
      await Promise.all(running);
      await Promise.all(idle.splice(0).map(({ thread }) => thread.stop()));
    },
  };
}
