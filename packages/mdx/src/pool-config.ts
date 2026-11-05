import { z } from 'zod';

const MAX_TIMEOUT_MS = 600_000;
const MAX_THREADS = 64;
const MAX_QUEUE = 4_096;
const MAX_WINDOW_MS = 86_400_000;

const poolShape = z.object({
  timeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  maxMemoryMb: z.int().min(16).max(8_192),
  // One thread would let one bomb stop every project.
  threads: z.int().min(2).max(MAX_THREADS),
  maxQueued: z.int().min(1).max(MAX_QUEUE),
  projectThreads: z.int().min(1).max(MAX_THREADS),
  maxQueuedPerProject: z.int().min(1).max(MAX_QUEUE),
  projectBudgetMs: z.int().min(1).max(MAX_WINDOW_MS),
  projectWindowMs: z.int().min(1).max(MAX_WINDOW_MS),
});

export type ParsePoolConfig = z.infer<typeof poolShape>;

export const poolConfigSchema = poolShape
  .refine((config) => config.projectThreads < config.threads, {
    message: 'one project must not be able to hold every thread',
  })
  .refine((config) => config.maxQueuedPerProject <= config.maxQueued, {
    message: 'a project queue cannot be longer than the whole queue',
  })
  .refine((config) => config.projectBudgetMs >= config.timeoutMs, {
    message: 'the budget has to cover at least one page',
  })
  .refine((config) => config.projectBudgetMs < config.projectWindowMs * config.projectThreads, {
    message: 'a budget a project cannot spend in its window limits nothing',
  });

const number = (fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number);

// Sized on the kill: a hostile page costs a full timeout, so the budget allows about fifteen
// of those a minute per project, far more parse time than any real save or sync page takes.
const envSchema = z
  .object({
    DREFYN_PARSE_TIMEOUT_MS: number(2_000),
    DREFYN_PARSE_WORKER_MEMORY_MB: number(512),
    DREFYN_PARSE_THREADS: number(2),
    DREFYN_PARSE_QUEUE_MAX: number(64),
    DREFYN_PARSE_PROJECT_THREADS: number(1),
    DREFYN_PARSE_PROJECT_QUEUE_MAX: number(16),
    DREFYN_PARSE_PROJECT_BUDGET_MS: number(30_000),
    DREFYN_PARSE_PROJECT_WINDOW_MS: number(60_000),
  })
  .transform((env) => ({
    timeoutMs: env.DREFYN_PARSE_TIMEOUT_MS,
    maxMemoryMb: env.DREFYN_PARSE_WORKER_MEMORY_MB,
    threads: env.DREFYN_PARSE_THREADS,
    maxQueued: env.DREFYN_PARSE_QUEUE_MAX,
    projectThreads: env.DREFYN_PARSE_PROJECT_THREADS,
    maxQueuedPerProject: env.DREFYN_PARSE_PROJECT_QUEUE_MAX,
    projectBudgetMs: env.DREFYN_PARSE_PROJECT_BUDGET_MS,
    projectWindowMs: env.DREFYN_PARSE_PROJECT_WINDOW_MS,
  }));

export function parsePoolConfig(
  env: Readonly<Record<string, string | undefined>>,
): ParsePoolConfig {
  return poolConfigSchema.parse(envSchema.parse(env));
}
