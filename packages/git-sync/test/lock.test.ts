import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bindingLockKey } from '../src/index.ts';

const tenantOf = (org: string, project: string): TenantRef => ({
  organizationId: organizationId(org),
  projectId: projectId(project),
});

const ORG = '01900000-0000-7000-8000-000000000001';
const OTHER_ORG = '01900000-0000-7000-8000-000000000002';
const PROJECT = '01900000-0000-7000-8000-000000000011';
const OTHER_PROJECT = '01900000-0000-7000-8000-000000000012';
const BINDING = '01900000-0000-7000-8000-000000000021';

describe('bindingLockKey', () => {
  it('is the same for the same tenant and binding', () => {
    expect(bindingLockKey(tenantOf(ORG, PROJECT), BINDING)).toBe(
      bindingLockKey(tenantOf(ORG, PROJECT), BINDING),
    );
  });

  it('differs when only the organization or the project differs', () => {
    const key = bindingLockKey(tenantOf(ORG, PROJECT), BINDING);
    expect(bindingLockKey(tenantOf(OTHER_ORG, PROJECT), BINDING)).not.toBe(key);
    expect(bindingLockKey(tenantOf(ORG, OTHER_PROJECT), BINDING)).not.toBe(key);
  });

  it('always fits a Postgres bigint', () => {
    fc.assert(
      fc.property(fc.uuid({ version: 7 }), (binding) => {
        const key = bindingLockKey(tenantOf(ORG, PROJECT), binding);
        expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
      }),
    );
  });
});
