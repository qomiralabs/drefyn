import { privateAllowList } from './address.ts';
import type { EgressPolicy, EgressPurpose } from './types.ts';

export const EGRESS_PURPOSES: readonly EgressPurpose[] = Object.freeze([
  'monitor',
  'webhook',
  'feed',
  'import',
  'spec_fetch',
  'try_it',
  'media_import',
]);

const KIB = 1024;
const MIB = 1024 * KIB;
const CONNECT_TIMEOUT_MS = 5_000;

type Defaults = Omit<EgressPolicy, 'purpose' | 'allowPrivate' | 'connectTimeoutMs'>;

const BULK: Defaults = {
  schemes: ['https'],
  ports: [443],
  maxRedirects: 3,
  totalTimeoutMs: 30_000,
  maxResponseBytes: 20 * MIB,
};

const DEFAULTS: Readonly<Record<EgressPurpose, Defaults>> = {
  monitor: {
    schemes: ['https', 'http'],
    ports: 'any',
    maxRedirects: 5,
    totalTimeoutMs: 30_000,
    maxResponseBytes: MIB,
  },
  webhook: {
    schemes: ['https'],
    ports: [443, 8443],
    maxRedirects: 0,
    totalTimeoutMs: 10_000,
    maxResponseBytes: 64 * KIB,
  },
  feed: {
    schemes: ['https'],
    ports: [443],
    maxRedirects: 3,
    totalTimeoutMs: 10_000,
    maxResponseBytes: MIB,
  },
  import: BULK,
  spec_fetch: BULK,
  media_import: BULK,
  try_it: {
    schemes: ['https', 'http'],
    ports: 'any',
    maxRedirects: 0,
    totalTimeoutMs: 15_000,
    maxResponseBytes: 5 * MIB,
  },
};

export interface PolicyOptions {
  /** Self host only: lets webhooks go out over plain http (DREFYN_WEBHOOK_ALLOW_HTTP). */
  readonly webhookAllowHttp?: boolean;
  /** Private probes and self hosted installs only: ranges that may be reached. */
  readonly allowPrivateCidrs?: readonly string[];
}

/** The default policy for a purpose. Spread it to tighten one field for a call site. */
export function policyFor(purpose: EgressPurpose, options: PolicyOptions = {}): EgressPolicy {
  const defaults = DEFAULTS[purpose];
  const schemes =
    purpose === 'webhook' && options.webhookAllowHttp === true
      ? (['https', 'http'] as const)
      : defaults.schemes;
  const cidrs = options.allowPrivateCidrs ?? [];
  const policy: EgressPolicy = {
    purpose,
    allowPrivate: cidrs.length === 0 ? false : { cidrs: [...cidrs] },
    schemes: [...schemes],
    ports: defaults.ports === 'any' ? 'any' : [...defaults.ports],
    maxRedirects: defaults.maxRedirects,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    totalTimeoutMs: defaults.totalTimeoutMs,
    maxResponseBytes: defaults.maxResponseBytes,
  };
  checkPolicy(policy);
  return Object.freeze(policy);
}

const positiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isPort = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;

function fail(field: string): never {
  throw new TypeError(`egress: invalid policy field ${field}`);
}

// A policy is written by our own code, so a bad one is a programming error and throws,
// unlike a bad URL, which is customer input and comes back as a Result.
export function checkPolicy(policy: EgressPolicy): void {
  if (!EGRESS_PURPOSES.includes(policy.purpose)) fail('purpose');
  const schemes: readonly unknown[] = policy.schemes;
  if (schemes.length === 0 || !schemes.every((s) => s === 'https' || s === 'http')) {
    fail('schemes');
  }
  const ports: unknown = policy.ports;
  if (ports !== 'any' && !(Array.isArray(ports) && ports.length > 0 && ports.every(isPort))) {
    fail('ports');
  }
  const redirects: unknown = policy.maxRedirects;
  if (
    typeof redirects !== 'number' ||
    !Number.isInteger(redirects) ||
    redirects < 0 ||
    redirects > 5
  ) {
    fail('maxRedirects');
  }
  if (!positiveInteger(policy.connectTimeoutMs)) fail('connectTimeoutMs');
  if (!positiveInteger(policy.totalTimeoutMs)) fail('totalTimeoutMs');
  if (!positiveInteger(policy.maxResponseBytes)) fail('maxResponseBytes');
  const allow: unknown = policy.allowPrivate;
  if (allow !== false) {
    const cidrs: unknown =
      typeof allow === 'object' && allow !== null ? Reflect.get(allow, 'cidrs') : undefined;
    if (!Array.isArray(cidrs) || cidrs.length === 0 || !cidrs.every((c) => typeof c === 'string')) {
      fail('allowPrivate');
    }
    privateAllowList(cidrs);
  }
}
