import { organizationId, projectId } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitSyncGate,
  GIT_SYNC_FEATURE,
  GIT_SYNC_FLAG,
  type GateSources,
} from '../src/index.ts';

const tenant = {
  organizationId: organizationId('01900000-0000-7000-8000-000000000001'),
  projectId: projectId('01900000-0000-7000-8000-000000000011'),
};

function sources(flag: boolean | Error, feature: boolean | Error) {
  const answer = (value: boolean | Error) =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const warn = vi.fn();
  const isOn = vi.fn(() => answer(flag));
  const hasFeature = vi.fn(() => answer(feature));
  const deps: GateSources = {
    flags: { isOn },
    entitlements: { hasFeature },
    logger: { info: vi.fn(), warn },
  };
  return { deps, warn, isOn, hasFeature };
}

describe('the git sync gate', () => {
  it('lets a tenant through with the flag on and the feature on the plan', async () => {
    const { deps, isOn, hasFeature } = sources(true, true);
    expect(await createGitSyncGate(deps).check(tenant)).toBeNull();
    expect(isOn).toHaveBeenCalledWith(GIT_SYNC_FLAG, tenant);
    expect(hasFeature).toHaveBeenCalledWith(tenant.organizationId, GIT_SYNC_FEATURE);
  });

  it('refuses with disabled when the flag is off, before reading the plan', async () => {
    const { deps, hasFeature } = sources(false, true);
    expect(await createGitSyncGate(deps).check(tenant)).toBe('git_sync.disabled');
    expect(hasFeature).not.toHaveBeenCalled();
  });

  it('refuses with not_entitled when the plan lacks the feature', async () => {
    const { deps } = sources(true, false);
    expect(await createGitSyncGate(deps).check(tenant)).toBe('git_sync.not_entitled');
  });

  it('fails closed and logs ids only when a read throws', async () => {
    const flagDown = sources(new Error('flagd 10.0.0.1 down'), true);
    expect(await createGitSyncGate(flagDown.deps).check(tenant)).toBe('git_sync.disabled');
    expect(flagDown.warn).toHaveBeenCalledWith('git_sync.gate_read_failed', {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      source: 'flag',
    });
    const planDown = sources(true, new Error('down'));
    expect(await createGitSyncGate(planDown.deps).check(tenant)).toBe('git_sync.not_entitled');
    expect(planDown.warn).toHaveBeenCalledWith(
      'git_sync.gate_read_failed',
      expect.objectContaining({ source: 'entitlement' }),
    );
  });
});
