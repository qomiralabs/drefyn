import { FlagError, type FlagConfigKey } from './errors.ts';

export const DEFAULT_FLAGS_FILE = '/etc/drefyn/flags.json';
export const DEFAULT_FLAGD_SYNC_PORT = 8015;
export const DEFAULT_EVAL_TIMEOUT_MS = 50;
export const DEFAULT_INIT_TIMEOUT_MS = 2000;

interface Timeouts {
  readonly evalTimeoutMs: number;
  readonly initTimeoutMs: number;
}

// Offline file mode: the provider reads the file in process, no daemon.
export interface FileFlagConfig extends Timeouts {
  readonly source: 'file';
  readonly file: string;
}

// In process sync from a flagd service. There is no RPC resolver option on purpose.
export interface FlagdFlagConfig extends Timeouts {
  readonly source: 'flagd';
  readonly host: string;
  readonly syncPort: number;
}

export type FlagConfig = FileFlagConfig | FlagdFlagConfig;

export type FlagEnv = Readonly<Record<string, string | undefined>>;

// setTimeout fires at once for anything above this, so a longer wait would be no wait.
const MAX_TIMER_MS = 2_147_483_647;
const DIGITS = /^[0-9]+$/;

function invalid(key: FlagConfigKey): never {
  // The key only: values can hold hosts, paths or credentials.
  throw new FlagError('FLAG_CONFIG_INVALID', { key });
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isHost(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !/\s/.test(value);
}

// Checks a config object field by field; anything the types allow but the runtime does not
// (NaN, a fraction, a port as text) is refused here as well, since configs are built by hand.
export function assertFlagConfig(config: unknown): asserts config is FlagConfig {
  if (typeof config !== 'object' || config === null) invalid('DREFYN_FLAGS_SOURCE');
  const c = config as Record<string, unknown>;
  const source = c['source'];
  if (source !== 'file' && source !== 'flagd') invalid('DREFYN_FLAGS_SOURCE');
  if (source === 'file') {
    const file = c['file'];
    if (typeof file !== 'string' || file === '') invalid('DREFYN_FLAGS_FILE');
  } else {
    if (!isWhole(c['syncPort'], 1, 65_535)) invalid('DREFYN_FLAGD_SYNC_PORT');
    if (!isHost(c['host'])) invalid('DREFYN_FLAGD_HOST');
  }
  if (!isWhole(c['evalTimeoutMs'], 1, MAX_TIMER_MS)) invalid('DREFYN_FLAGS_EVAL_TIMEOUT_MS');
  if (!isWhole(c['initTimeoutMs'], 0, MAX_TIMER_MS)) invalid('DREFYN_FLAGS_INIT_TIMEOUT_MS');
}

// Compose passes an unset variable as an empty string.
function read(env: FlagEnv, key: FlagConfigKey): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

// Plain digits only: Number() would also take ' 50', '1e2', '0x1f' and 'Infinity'.
function whole(env: FlagEnv, key: FlagConfigKey, fallback: number, min: number, max: number) {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  if (!DIGITS.test(raw)) invalid(key);
  const value = Number(raw);
  if (!isWhole(value, min, max)) invalid(key);
  return value;
}

// Reads the DREFYN_FLAGS_* and DREFYN_FLAGD_* keys; anything invalid throws
// FLAG_CONFIG_INVALID naming the key. Every key is checked even when the source does not
// use it, so a typo shows at start rather than on the day someone switches source.
export function loadFlagConfig(env: FlagEnv): FlagConfig {
  const source = read(env, 'DREFYN_FLAGS_SOURCE') ?? 'file';
  if (source !== 'file' && source !== 'flagd') invalid('DREFYN_FLAGS_SOURCE');
  const file = read(env, 'DREFYN_FLAGS_FILE') ?? DEFAULT_FLAGS_FILE;
  const syncPort = whole(env, 'DREFYN_FLAGD_SYNC_PORT', DEFAULT_FLAGD_SYNC_PORT, 1, 65_535);
  const evalTimeoutMs = whole(
    env,
    'DREFYN_FLAGS_EVAL_TIMEOUT_MS',
    DEFAULT_EVAL_TIMEOUT_MS,
    1,
    MAX_TIMER_MS,
  );
  const initTimeoutMs = whole(
    env,
    'DREFYN_FLAGS_INIT_TIMEOUT_MS',
    DEFAULT_INIT_TIMEOUT_MS,
    0,
    MAX_TIMER_MS,
  );
  const host = read(env, 'DREFYN_FLAGD_HOST');
  if (host !== undefined && !isHost(host)) invalid('DREFYN_FLAGD_HOST');
  if (source === 'file') return { source, file, evalTimeoutMs, initTimeoutMs };
  if (host === undefined) invalid('DREFYN_FLAGD_HOST');
  return { source, host, syncPort, evalTimeoutMs, initTimeoutMs };
}
