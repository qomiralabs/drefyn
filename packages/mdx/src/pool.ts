import { createHash } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';
import { organizationId as toOrganizationId, projectId as toProjectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { timingSchema } from './answer.ts';
import { parseInputSchema } from './policy.ts';
import { poolConfigSchema } from './pool-config.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import { refused } from './result.ts';
import type { JobResult } from './result.ts';
import { RECYCLE_AFTER_JOBS, startParseThread } from './thread.ts';
import type { IsolatedPolicy, ParseThread, ThreadAnswer, ThreadJob } from './thread.ts';
import type { Dialect, MdxIssueCode, ParseResult, PrintResult } from './types.ts';
import { maxTreeBytes } from './wire.ts';

// Interactive for a save a person is waiting on. It orders pages inside an organization and is
// ranked on interactive time alone, so a sync never pushes a save back, and marking bombs
// interactive earns nothing, since each one is charged to the next.
export type ParsePriority = 'interactive' | 'bulk';

export interface ParseRequest {
  readonly tenant: TenantRef;
  // Where the page lives. Logged, so it never holds page text.
  readonly path: string;
  readonly source: string;
  readonly dialect: Dialect;
  readonly policy: IsolatedPolicy;
  readonly priority?: ParsePriority;
}

export interface PrintRequest {
  readonly tenant: TenantRef;
  // Logged, so it never holds page text.
  readonly path: string;
  // A stored tree as JSON text.
  readonly tree: string;
  readonly policy: IsolatedPolicy;
  readonly priority?: ParsePriority;
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
  readonly interactive: boolean;
  readonly resolve: (result: JobResult) => void;
}

interface Budget {
  active: number;
  windowStart: number;
  spentMs: number;
  interactiveMs: number;
}

interface Project extends Budget {
  readonly key: string;
  readonly waiting: Waiting[];
}

interface Organization extends Budget {
  readonly key: string;
  // Insertion order is the turn order inside an organization.
  readonly projects: Map<string, Project>;
  queued: number;
  // Lowest goes first among equals. See takeTurn.
  turn: number;
}

interface Pick {
  readonly organization: Organization;
  readonly project: Project;
  readonly index: number;
  readonly rank: number;
}

interface Slot {
  readonly thread: ParseThread;
  jobs: number;
}

// Only a print has steps to report, and only the pool knows the wait ahead of them. A timing that
// fails its schema goes, and unknown keys with it, so a thread cannot write a tenant field or page
// text into a log line.
function withHostTimes(result: JobResult, waitedMs: number, threadMs: number): JobResult {
  if (!result.ok || !('timing' in result.value)) return result;
  const { timing, ...value } = result.value;
  const checked = timingSchema.safeParse(timing);
  if (!checked.success) return { ...result, value };
  return { ...result, value: { ...value, timing: { ...checked.data, waitedMs, threadMs } } };
}

export function createParsePool(config: ParsePoolConfig, deps: ParsePoolDeps): ParsePool {
  const settings = poolConfigSchema.parse(config);
  const now = deps.now ?? (() => performance.now());
  const startThread =
    deps.startThread ??
    (() => startParseThread(new URL('./parse-worker.ts', import.meta.url), settings));

  const organizations = new Map<string, Organization>();
  const idle: Slot[] = [];
  const running = new Set<Promise<void>>();
  let busy = 0;
  let queued = 0;
  let closed = false;
  let lastSweep = now();
  let turns = 0;

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
      budget.interactiveMs = 0;
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
      if (item.interactive) budget.interactiveMs += outcome.workMs;
    }
    if (slot !== undefined) release(slot, outcome.end, item.fields);
    const result = withHostTimes(outcome.result, waitedMs, outcome.workMs);
    const timing = result.ok && 'timing' in result.value ? result.value.timing : undefined;
    report({ ...timing, ...item.fields, waitedMs, tookMs: outcome.workMs }, result);
    item.resolve(result);
    pump();
  };

  // Whole kills, not milliseconds. Real pages cost a few milliseconds, and that must not put a
  // person behind a stranger's first bomb, which looks the same until it has run.
  const killsIn = (ms: number) => Math.floor(ms / settings.timeoutMs);

  const nextPage = (organization: Organization): Pick | undefined => {
    let pick: Pick | undefined;
    for (const project of organization.projects.values()) {
      if (project.waiting.length === 0) continue;
      if (spent(project, settings.projectBudgetMs)) {
        refuseProject(organization, project, 'mdx.project_limit');
      } else if (project.active < settings.projectThreads) {
        const index = project.waiting.findIndex(({ interactive }) => interactive);
        if (index !== -1) {
          return { organization, project, index, rank: killsIn(organization.interactiveMs) };
        }
        pick ??= { organization, project, index: 0, rank: killsIn(organization.spentMs) };
      }
    }
    return pick;
  };

  // Least thread time first, however the organizations arrived. A place in a queue is not a turn
  // on a thread: taking turns gave eight organizations eight turns for each honest save, each
  // holding a thread for a whole kill. Now colluders only compete with each other, and someone
  // who has spent nothing waits for one running job.
  const nextJob = (): Pick | undefined => {
    let best: Pick | undefined;
    for (const organization of organizations.values()) {
      if (organization.queued === 0) continue;
      if (spent(organization, settings.orgBudgetMs)) {
        refuseOrganization(organization, 'mdx.organization_limit');
      } else if (organization.active < settings.orgThreads) {
        const pick = nextPage(organization);
        const ahead =
          pick !== undefined &&
          (best === undefined ||
            pick.rank < best.rank ||
            (pick.rank === best.rank && organization.turn < best.organization.turn));
        if (ahead) best = pick;
      }
    }
    return best;
  };

  function pump() {
    while (busy < settings.threads) {
      const next = nextJob();
      if (next === undefined) return;
      const { organization, project, index } = next;
      const item = project.waiting.splice(index, 1)[0];
      if (item === undefined) return;
      queued -= 1;
      organization.queued -= 1;
      busy += 1;
      organization.active += 1;
      project.active += 1;
      turns += 1;
      organization.turn = turns;
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
      turn: 0,
      windowStart: now(),
      spentMs: 0,
      interactiveMs: 0,
    };
    organizations.set(key, organization);
    return organization;
  };

  const projectOf = (organization: Organization, key: string): Project => {
    const known = organization.projects.get(key);
    if (known !== undefined) return known;
    const project = {
      key,
      waiting: [],
      active: 0,
      windowStart: now(),
      spentMs: 0,
      interactiveMs: 0,
    };
    organization.projects.set(key, project);
    return project;
  };

  const holdingMost = () =>
    [...organizations.values()].reduce<Organization | undefined>((most, organization) => {
      rollWindow(organization);
      const ahead =
        most === undefined ||
        organization.queued > most.queued ||
        (organization.queued === most.queued && organization.spentMs > most.spentMs);
      return ahead ? organization : most;
    }, undefined);

  const longestQueue = ({ projects }: Organization) =>
    [...projects.values()].reduce<Project | undefined>(
      (most, project) =>
        most === undefined || project.waiting.length > most.waiting.length ? project : most,
      undefined,
    );

  // Limits on one organization cannot stop several filling the queue, and a new organization is
  // cheap. So a full queue takes a page from whoever holds most for whoever holds less, and when
  // holdings are level from whoever has spent most for whoever has spent less. The page given up
  // never ran, so it costs its owner no budget, and it gets the same refusal as a full queue.
  const makeRoomFor = (asking: Organization): boolean => {
    const fullest = holdingMost();
    if (fullest === undefined) return false;
    rollWindow(asking);
    const heldMore = fullest.queued - asking.queued;
    const spentMore = killsIn(fullest.spentMs) > killsIn(asking.spentMs);
    if (heldMore < 1 || (heldMore === 1 && !spentMore)) return false;
    const item = longestQueue(fullest)?.waiting.pop();
    if (item === undefined) return false;
    queued -= 1;
    fullest.queued -= 1;
    const result = refused('mdx.queue_full');
    report(item.fields, result);
    item.resolve(result);
    return true;
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
    priority: ParsePriority = 'bulk',
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
    if (queued >= settings.maxQueued && !makeRoomFor(organization)) {
      return instant('mdx.queue_full', fields);
    }

    return new Promise((resolve) => {
      const interactive = priority === 'interactive';
      project.waiting.push({ job, fields, queuedAt: now(), interactive, resolve });
      queued += 1;
      // Back from nothing goes ahead of anyone of the same rank, newest first. Otherwise a flood
      // of new organizations, none of which has been charged yet, sits ahead of a person.
      if (organization.queued === 0 && organization.active === 0) {
        turns += 1;
        organization.turn = -turns;
      }
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
    return await enqueue(job, source, tenant, base, request.priority);
  };

  const print = async (request: PrintRequest): Promise<PrintResult> => {
    const { tenant } = requestSchema.parse(request);
    parseInputSchema.shape.policy.parse(request.policy);
    const { tree, path, policy } = request;
    const { organizationId, projectId } = tenant;
    const bytes = Buffer.byteLength(tree, 'utf8');
    const base = { organizationId, projectId, path, bytes };
    if (bytes > maxTreeBytes(policy.limits.maxBytes)) return instant('mdx.too_large', base);
    return (await enqueue({ tree, policy }, tree, tenant, base, request.priority)) as PrintResult;
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
