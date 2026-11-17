import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { policyFor } from '@drefyn/egress';
import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_SECRET_BYTES = 16;

export interface GitHubAppConfig {
  readonly appId: number;
  // Read once by the broker. Never an env value, so the key is never in a process listing.
  readonly privateKeyFile: string;
  // No trailing slash. A GitHub Enterprise Server API keeps its path, such as /api/v3.
  readonly apiUrl: string;
  // Self hosted GitHub Enterprise Server on a private network only.
  readonly allowPrivateCidrs: readonly string[];
  readonly callTimeoutMs: number;
}

export interface GitHubWebhookConfig {
  readonly secretFile: string;
}

export class GitHubConfigError extends Error {
  readonly key: string;

  // Fixed text only: a value may be a secret pasted into the wrong key.
  constructor(key: string, reason: string) {
    super(`${key} ${reason}`);
    this.key = key;
  }
}
Object.defineProperty(GitHubConfigError.prototype, 'name', { value: 'GitHubConfigError' });

// Compose passes an unset variable as an empty string.
function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

const digits = (max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,16}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

function absolutePath(env: Env, key: string): string {
  const value = read(env, key);
  if (value === undefined || !isAbsolute(value)) {
    throw new GitHubConfigError(key, 'must be an absolute file path');
  }
  return value;
}

function apiUrl(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_GITHUB_API_URL;
  const url = URL.parse(raw);
  const plain =
    url !== null &&
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!plain) {
    throw new GitHubConfigError(
      'DREFYN_GITHUB_API_URL',
      'must be an https URL with no user, query or fragment',
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function cidrs(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const list = raw.split(',').map((part) => part.trim());
  try {
    // The guard's own parser, so a range passes here exactly when the guard will take it.
    policyFor('github', { allowPrivateCidrs: list });
  } catch {
    throw new GitHubConfigError(
      'DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS',
      'must be a comma separated list of address ranges',
    );
  }
  return list;
}

export function parseGitHubAppConfig(env: Env): GitHubAppConfig {
  const appId = digits(Number.MAX_SAFE_INTEGER).safeParse(read(env, 'DREFYN_GITHUB_APP_ID') ?? '');
  if (!appId.success) {
    throw new GitHubConfigError('DREFYN_GITHUB_APP_ID', 'must be the numeric App id');
  }
  const privateKeyFile = absolutePath(env, 'DREFYN_GITHUB_PRIVATE_KEY_FILE');
  const timeoutRaw = read(env, 'DREFYN_GITHUB_CALL_TIMEOUT_MS');
  let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    const parsed = digits(MAX_TIMEOUT_MS).safeParse(timeoutRaw);
    if (!parsed.success || parsed.data < MIN_TIMEOUT_MS) {
      throw new GitHubConfigError(
        'DREFYN_GITHUB_CALL_TIMEOUT_MS',
        `must be a whole number from ${String(MIN_TIMEOUT_MS)} to ${String(MAX_TIMEOUT_MS)}`,
      );
    }
    callTimeoutMs = parsed.data;
  }
  return {
    appId: appId.data,
    privateKeyFile,
    apiUrl: apiUrl(read(env, 'DREFYN_GITHUB_API_URL')),
    allowPrivateCidrs: cidrs(read(env, 'DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS')),
    callTimeoutMs,
  };
}

// Null when the install has no GitHub App, so the API mounts no webhook route at all.
export function parseGitHubWebhookConfig(env: Env): GitHubWebhookConfig | null {
  if (read(env, 'DREFYN_GITHUB_WEBHOOK_SECRET_FILE') === undefined) return null;
  return { secretFile: absolutePath(env, 'DREFYN_GITHUB_WEBHOOK_SECRET_FILE') };
}

// The secret as bytes, with the one trailing newline an editor or `echo` leaves.
export function readWebhookSecret(file: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new GitHubConfigError('DREFYN_GITHUB_WEBHOOK_SECRET_FILE', 'cannot be read');
  }
  let end = bytes.length;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (bytes[end - 1] === 0x0d) end -= 1;
  if (end < MIN_SECRET_BYTES) {
    throw new GitHubConfigError(
      'DREFYN_GITHUB_WEBHOOK_SECRET_FILE',
      `must hold a secret of at least ${String(MIN_SECRET_BYTES)} bytes`,
    );
  }
  return new Uint8Array(bytes.subarray(0, end));
}
