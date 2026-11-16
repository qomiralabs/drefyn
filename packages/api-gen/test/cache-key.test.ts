import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { schemaCacheKey } from '../src/index.ts';
import { ORG, PRJ } from './support.ts';

const tenant = (org: string, prj: string): TenantRef => ({
  organizationId: organizationId(org),
  projectId: projectId(prj),
});

describe('schemaCacheKey', () => {
  it('carries both tenant ids and the schema scope', () => {
    const key = schemaCacheKey(tenant(ORG, PRJ), 4);
    expect(key.startsWith(`v1:${ORG}:${PRJ}:schema:`)).toBe(true);
  });

  it('never shares a key across organizations, projects or versions', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.nat(),
        fc.nat(),
        (orgA, orgB, prjA, prjB, versionA, versionB) => {
          const a = schemaCacheKey(tenant(orgA, prjA), versionA);
          const b = schemaCacheKey(tenant(orgB, prjB), versionB);
          const same = orgA === orgB && prjA === prjB && versionA === versionB;
          expect(a === b).toBe(same);
        },
      ),
    );
  });

  it('keeps the same project id apart under two organizations', () => {
    const other = '0190a7b0-0000-7000-8000-0000000000ff';
    expect(schemaCacheKey(tenant(ORG, PRJ), 1)).not.toBe(schemaCacheKey(tenant(other, PRJ), 1));
    expect(schemaCacheKey(tenant(ORG, PRJ), 1)).not.toBe(schemaCacheKey(tenant(ORG, other), 1));
  });

  it('is stable for the same input', () => {
    expect(schemaCacheKey(tenant(ORG, PRJ), 9)).toBe(schemaCacheKey(tenant(ORG, PRJ), 9));
  });

  it('refuses a version that is not a whole number at or above zero', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => schemaCacheKey(tenant(ORG, PRJ), version)).toThrow(RangeError);
    }
  });

  it('refuses a forged tenant', () => {
    const forged = { organizationId: 'a:b', projectId: PRJ } as unknown as TenantRef;
    expect(() => schemaCacheKey(forged, 1)).toThrow();
  });
});
