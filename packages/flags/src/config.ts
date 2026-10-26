import { notImplemented } from './errors.ts';

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

// Reads the DREFYN_FLAGS_* and DREFYN_FLAGD_* keys; anything invalid throws
// FLAG_CONFIG_INVALID naming the key.
export function loadFlagConfig(env: FlagEnv): FlagConfig {
  return notImplemented('loadFlagConfig', env);
}
