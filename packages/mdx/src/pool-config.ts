import { z } from 'zod';
import { DEFAULT_MERGE_MAX_BLOCKS } from './policy.ts';

const MAX_TIMEOUT_MS = 600_000;
const MAX_THREADS = 64;
const MAX_QUEUE = 4_096;
const MAX_WINDOW_MS = 86_400_000;
const MAX_MERGE_BLOCKS = 1_000_000;

// A print is a print plus a whole parse. The largest honest page took up to 3.6 s of thread time
// on a CI runner, so it would die at the parse limit on a machine of that size.
export const DEFAULT_PRINT_TIMEOUT_MS = 6_000;

const budget = z.int().min(1).max(MAX_WINDOW_MS);

const poolShape = z.object({
  timeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  printTimeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  maxMemoryMb: z.int().min(16).max(8_192),
  // One thread would let one bomb stop every organization.
  threads: z.int().min(2).max(MAX_THREADS),
  maxQueued: z.int().min(2).max(MAX_QUEUE),
  orgThreads: z.int().min(1).max(MAX_THREADS),
  projectThreads: z.int().min(1).max(MAX_THREADS),
  maxQueuedPerOrg: z.int().min(1).max(MAX_QUEUE),
  maxQueuedPerProject: z.int().min(1).max(MAX_QUEUE),
  orgBudgetMs: budget,
  projectBudgetMs: budget,
  windowMs: budget,
  killGraceMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  maxMergeBlocks: z.int().min(1).max(MAX_MERGE_BLOCKS),
});

export type ParsePoolConfig = z.infer<typeof poolShape>;

// Project limits sit inside organization limits, and an organization never gets the whole of
// anything: new project ids are free, so nothing narrower holds against one tenant.
export const poolConfigSchema = poolShape
  .refine((config) => config.orgThreads < config.threads, {
    message: 'one organization must not be able to hold every thread',
  })
  .refine((config) => config.projectThreads <= config.orgThreads, {
    message: 'a project cannot hold more threads than its organization',
  })
  .refine((config) => config.maxQueuedPerOrg < config.maxQueued, {
    message: 'one organization must not be able to fill the queue',
  })
  .refine((config) => config.maxQueuedPerProject <= config.maxQueuedPerOrg, {
    message: 'a project queue cannot be longer than its organization queue',
  })
  .refine((config) => config.projectBudgetMs <= config.orgBudgetMs, {
    message: 'a project budget cannot be larger than its organization budget',
  })
  .refine((config) => config.printTimeoutMs >= config.timeoutMs, {
    message: 'a print holds a whole parse, so it cannot have less time than one',
  })
  .refine((config) => config.projectBudgetMs >= config.printTimeoutMs, {
    message: 'a project budget under the print limit would refuse a print it could finish',
  })
  .refine((config) => config.projectBudgetMs >= config.timeoutMs, {
    message: 'the budget has to cover at least one page',
  })
  .refine((config) => config.orgBudgetMs < config.windowMs * config.orgThreads, {
    message: 'a budget an organization cannot spend in its window limits nothing',
  });

const number = (fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number);

// Sized on the kill: a hostile page costs a full timeout, so an organization gets about fifteen
// of those a minute and a project ten, far more parse time than any real save takes.
const envShape = {
  DREFYN_PARSE_TIMEOUT_MS: number(2_000),
  DREFYN_PARSE_PRINT_TIMEOUT_MS: number(DEFAULT_PRINT_TIMEOUT_MS),
  DREFYN_PARSE_WORKER_MEMORY_MB: number(512),
  DREFYN_PARSE_THREADS: number(2),
  DREFYN_PARSE_QUEUE_MAX: number(64),
  DREFYN_PARSE_ORG_THREADS: number(1),
  DREFYN_PARSE_PROJECT_THREADS: number(1),
  DREFYN_PARSE_ORG_QUEUE_MAX: number(8),
  DREFYN_PARSE_PROJECT_QUEUE_MAX: number(4),
  DREFYN_PARSE_ORG_BUDGET_MS: number(30_000),
  DREFYN_PARSE_PROJECT_BUDGET_MS: number(20_000),
  DREFYN_PARSE_WINDOW_MS: number(60_000),
  DREFYN_PARSE_KILL_GRACE_MS: number(2_000),
  DREFYN_MDX_MERGE_MAX_BLOCKS: number(DEFAULT_MERGE_MAX_BLOCKS),
};

export const POOL_ENV_KEYS = Object.keys(envShape);

export const envSchema = z.object(envShape).transform((env) => ({
  timeoutMs: env.DREFYN_PARSE_TIMEOUT_MS,
  printTimeoutMs: env.DREFYN_PARSE_PRINT_TIMEOUT_MS,
  maxMemoryMb: env.DREFYN_PARSE_WORKER_MEMORY_MB,
  threads: env.DREFYN_PARSE_THREADS,
  maxQueued: env.DREFYN_PARSE_QUEUE_MAX,
  orgThreads: env.DREFYN_PARSE_ORG_THREADS,
  projectThreads: env.DREFYN_PARSE_PROJECT_THREADS,
  maxQueuedPerOrg: env.DREFYN_PARSE_ORG_QUEUE_MAX,
  maxQueuedPerProject: env.DREFYN_PARSE_PROJECT_QUEUE_MAX,
  orgBudgetMs: env.DREFYN_PARSE_ORG_BUDGET_MS,
  projectBudgetMs: env.DREFYN_PARSE_PROJECT_BUDGET_MS,
  windowMs: env.DREFYN_PARSE_WINDOW_MS,
  killGraceMs: env.DREFYN_PARSE_KILL_GRACE_MS,
  maxMergeBlocks: env.DREFYN_MDX_MERGE_MAX_BLOCKS,
}));

export function parsePoolConfig(
  env: Readonly<Record<string, string | undefined>>,
): ParsePoolConfig {
  return poolConfigSchema.parse(envSchema.parse(env));
}
