import { z } from 'zod';
import { DEFAULT_MAX_HELD_BYTES } from './held-bytes.ts';
import { envSchema, POOL_ENV_KEYS, poolConfigSchema } from './pool-config.ts';
import { SUPERVISOR_ENV_KEYS } from './supervisor-config.ts';
import type { ParsePoolConfig } from './pool-config.ts';

export interface ParseHostConfig {
  readonly pool: ParsePoolConfig;
  readonly port: number;
  readonly bind: string;
  readonly tokenSha256: string;
  readonly hostMemoryMb: number;
  readonly maxHeldBytes: number;
}

// Room for the runtime and native memory on top of every thread at its cap.
const HOST_OVERHEAD_MB = 256;
const BYTES_PER_MB = 1_048_576;
// An organization gets a quarter, and that has to hold the largest body that can be honest.
const MIN_HELD_BYTES = 64 * BYTES_PER_MB;

const hostSchema = z.object({
  // Loopback unless a deployment says otherwise. The compose service, on its closed network,
  // binds every interface it has, and that is only ever the one.
  DREFYN_PARSE_BIND: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
  // The hash and never the token: this process holds nothing a stranger could use.
  DREFYN_PARSE_TOKEN_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
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
    bind: host.DREFYN_PARSE_BIND,
    tokenSha256: host.DREFYN_PARSE_TOKEN_SHA256,
    hostMemoryMb: host.DREFYN_PARSE_HOST_MEMORY_MB,
    maxHeldBytes: host.DREFYN_PARSE_MAX_HELD_BYTES,
  };
}

// A list of what may be here, not of what may not: a new secret must fail closed, even one that
// carries our prefix. The first keys are what a container or a Node image sets for itself.
const HOST_KEYS = new Set([
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
  ...Object.keys(hostSchema.shape),
  ...POOL_ENV_KEYS,
  ...SUPERVISOR_ENV_KEYS,
]);

export function assertHostEnv(env: Readonly<Record<string, string | undefined>>): void {
  const extra = Object.keys(env).filter((key) => !HOST_KEYS.has(key));
  // Names only: a value here could be the very secret that should not have come.
  if (extra.length > 0) {
    throw new Error(`the parse host refuses these environment keys: ${extra.join(', ')}`);
  }
}

const HOST_FLAG = /^--(?:permission|allow-worker|allow-fs-read=[^*]+)$/;

// Checks what was allowed, not only that a flag was given: --allow-fs-read=* or
// --allow-child-process starts cleanly otherwise, and looks the same from outside.
export function assertHostFlags(
  execArgv: readonly string[],
  canRead: (path: string) => boolean,
): void {
  if (!execArgv.includes('--permission')) {
    throw new Error('the parse host runs only under --permission');
  }
  const extra = execArgv.filter((flag) => !HOST_FLAG.test(flag));
  if (extra.length > 0) {
    throw new Error(`the parse host refuses these flags: ${extra.join(' ')}`);
  }
  if (canRead('/etc/passwd')) {
    throw new Error('the parse host must not reach outside its own code');
  }
}
