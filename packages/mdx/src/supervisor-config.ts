import { z } from 'zod';

const number = (fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number)
    .pipe(z.int().min(1));

const envShape = {
  DREFYN_PARSE_RESTART_BACKOFF_MS: number(250),
  DREFYN_PARSE_RESTART_MAX_MS: number(30_000),
  DREFYN_PARSE_CRASH_LIMIT: number(5),
  DREFYN_PARSE_CRASH_WINDOW_MS: number(60_000),
  DREFYN_PARSE_COOL_OFF_MS: number(300_000),
};

export const SUPERVISOR_ENV_KEYS = Object.keys(envShape);

export interface SupervisorConfig {
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  readonly crashLimit: number;
  readonly crashWindowMs: number;
  readonly coolOffMs: number;
}

export function parseSupervisorConfig(
  env: Readonly<Record<string, string | undefined>>,
): SupervisorConfig {
  const parsed = z.object(envShape).parse(env);
  return {
    backoffMs: parsed.DREFYN_PARSE_RESTART_BACKOFF_MS,
    maxBackoffMs: parsed.DREFYN_PARSE_RESTART_MAX_MS,
    crashLimit: parsed.DREFYN_PARSE_CRASH_LIMIT,
    crashWindowMs: parsed.DREFYN_PARSE_CRASH_WINDOW_MS,
    coolOffMs: parsed.DREFYN_PARSE_COOL_OFF_MS,
  };
}
