import { organizationId, projectId } from '@drefyn/tenancy';
import { vi } from 'vitest';
import {
  defineFlags,
  type EntitlementsReader,
  type FlagConfig,
  type FlagContext,
  type FlagLogger,
  type FlagMetrics,
} from '../../src/index.ts';

// One flag of each kind, and a kill switch of each safe value, so every rule has a case.
export const fixtureFlags = defineFlags([
  {
    name: 'status.browser_checks',
    kind: 'release',
    owner: 'Divine572',
    description: 'Browser checks run from the probe fleet.',
    created: '2026-10-01',
    removeBy: '2027-03-01',
    safeValue: false,
  },
  {
    name: 'content.standard_render',
    kind: 'kill_switch',
    owner: 'Divine572',
    description: 'On renders with the standard policy; off forces strict safe mode.',
    created: '2026-10-01',
    removeBy: '2027-10-01',
    safeValue: true,
  },
  {
    name: 'status.auto_state_changes',
    kind: 'kill_switch',
    owner: 'Divine572',
    description: 'On lets the rule engine change public state; off only proposes.',
    created: '2026-10-01',
    removeBy: '2027-10-01',
    safeValue: false,
  },
  {
    name: 'docs.versioning',
    kind: 'plan',
    owner: 'Divine572',
    description: 'Versioned docs, from the growth tier.',
    created: '2026-10-01',
    removeBy: '2027-10-01',
    feature: 'docs.versioning',
  },
  {
    name: 'site.hero_copy',
    kind: 'experiment',
    owner: 'Divine572',
    description: 'Second hero headline.',
    created: '2026-10-01',
    removeBy: '2027-01-01',
    safeValue: false,
    metric: 'Signups per visit over 14 days',
  },
]);

export const RELEASE = 'status.browser_checks';
export const KILL_SAFE_ON = 'content.standard_render';
export const KILL_SAFE_OFF = 'status.auto_state_changes';
export const PLAN = 'docs.versioning';
export const EXPERIMENT = 'site.hero_copy';

export const ORG = organizationId('0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f');
export const OTHER_ORG = organizationId('0192b7a4-5c1e-7d2a-9f3b-ffffffffffff');
export const PROJECT = projectId('0192b7a4-5c1e-7d2a-9f3b-000000000001');
export const USER = 'usr-personal-7f3a';

export const ctx: FlagContext = { organizationId: ORG };
export const fullCtx: FlagContext = {
  organizationId: ORG,
  projectId: PROJECT,
  userId: USER,
  internal: true,
};

export const fileConfig: FlagConfig = {
  source: 'file',
  file: '/etc/drefyn/flags.json',
  evalTimeoutMs: 50,
  initTimeoutMs: 2000,
};

export const flagdConfig: FlagConfig = {
  source: 'flagd',
  host: 'flagd.internal',
  syncPort: 8015,
  evalTimeoutMs: 50,
  initTimeoutMs: 2000,
};

export function entitlements(
  answer: (feature: string) => Promise<boolean> = () => Promise.resolve(false),
) {
  const hasFeature = vi.fn((_org: unknown, feature: string) => answer(feature));
  return { reader: { hasFeature } as unknown as EntitlementsReader, hasFeature };
}

export function recorders() {
  const warn = vi.fn<FlagLogger['warn']>();
  const gauge = vi.fn<FlagMetrics['gauge']>();
  const histogram = vi.fn<FlagMetrics['histogram']>();
  return { logger: { warn }, metrics: { gauge, histogram }, warn, gauge, histogram };
}

// Starts an evaluation, moves the fake clock past the wrapper timeout, and returns it.
export async function settle<T>(pending: Promise<T>, ms = 50): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}
