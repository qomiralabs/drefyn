import { z } from 'zod';
import { DEFAULT_MAX_HELD_BYTES } from './held-bytes.ts';
import { envSchema, poolConfigSchema } from './pool-config.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import { DEFAULT_LIMITS } from './policy.ts';
import { maxMergeBodyBytes } from './wire.ts';

export interface ParseHostConfig {
  readonly pool: ParsePoolConfig;
  readonly port: number;
  readonly hostMemoryMb: number;
  readonly maxHeldBytes: number;
}

// Room for the runtime and native memory on top of every thread at its cap.
const HOST_OVERHEAD_MB = 256;
const BYTES_PER_MB = 1_048_576;
// An organization gets a quarter, and that has to hold the largest body that can be honest.
const MIN_HELD_BYTES = 4 * maxMergeBodyBytes(DEFAULT_LIMITS.maxBytes);

const hostSchema = z.object({
  DREFYN_PARSE_PORT: z
    .string()
    .regex(/^[0-9]{1,5}$/)
    .default('8787')
    .transform(Number)
    .pipe(z.int().max(65_535)),
  DREFYN_PARSE_HOST_MEMORY_MB: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .default('1536')
    .transform(Number),
  DREFYN_PARSE_MAX_HELD_BYTES: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .default(String(DEFAULT_MAX_HELD_BYTES))
    .transform(Number)
    .pipe(z.int().min(MIN_HELD_BYTES)),
});

export function parseHostConfig(
  env: Readonly<Record<string, string | undefined>>,
): ParseHostConfig {
  const host = hostSchema.parse(env);
  const pool = poolConfigSchema.parse(envSchema.parse(env));
  const heldMb = Math.ceil(host.DREFYN_PARSE_MAX_HELD_BYTES / BYTES_PER_MB);
  const floor = pool.threads * pool.maxMemoryMb + HOST_OVERHEAD_MB + heldMb;
  if (host.DREFYN_PARSE_HOST_MEMORY_MB < floor) {
    throw new Error(`DREFYN_PARSE_HOST_MEMORY_MB must be at least ${floor}`);
  }
  return {
    pool,
    port: host.DREFYN_PARSE_PORT,
    hostMemoryMb: host.DREFYN_PARSE_HOST_MEMORY_MB,
    maxHeldBytes: host.DREFYN_PARSE_MAX_HELD_BYTES,
  };
}

// A list of what may be here, not of what may not: a new secret must fail closed. These are
// what a container or a Node image sets for itself.
const OWN_KEYS = new Set(['DREFYN_MDX_MERGE_MAX_BLOCKS']);

const PLATFORM_KEYS = new Set([
  'HOME',
  'HOSTNAME',
  'LANG',
  'NODE_ENV',
  'NODE_VERSION',
  'PATH',
  'PWD',
  'SHLVL',
  'TERM',
  'TZ',
  'YARN_VERSION',
  // macOS adds this to every process, even one started with an empty environment.
  '__CF_USER_TEXT_ENCODING',
]);

export function assertHostEnv(env: Readonly<Record<string, string | undefined>>): void {
  const extra = Object.keys(env).filter(
    (key) => !PLATFORM_KEYS.has(key) && !OWN_KEYS.has(key) && !key.startsWith('DREFYN_PARSE_'),
  );
  // Names only: a value here could be the very secret that should not have come.
  if (extra.length > 0) {
    throw new Error(`the parse host refuses these environment keys: ${extra.join(', ')}`);
  }
}
