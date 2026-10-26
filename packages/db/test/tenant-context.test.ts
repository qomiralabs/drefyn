import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import { tenantSettings, transactionTimeout } from '../src/tenant-context.ts';
import { thrown } from './support.ts';

const ORG = '01a14984-4476-77ce-9335-2c3c3a59aa8b';
const PROJECT = '01a14984-4476-77ce-9335-2c3c3a59aa8c';

function code(fn: () => unknown): string {
  const error = thrown(fn);
  return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`;
}

describe('tenantSettings', () => {
  it('takes a TenantRef as both settings', () => {
    expect(tenantSettings({ organizationId: ORG, projectId: PROJECT }, 'organization')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
    });
    expect(tenantSettings({ organizationId: ORG, projectId: PROJECT }, 'project')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
    });
  });

  // The project is always set, to empty here, so nothing left on the session can stand in.
  it('takes an OrganizationRef with an empty project', () => {
    expect(tenantSettings({ organizationId: ORG }, 'organization')).toEqual({
      organizationId: ORG,
      projectId: '',
    });
    expect(tenantSettings({ organizationId: ORG, projectId: undefined }, 'organization')).toEqual({
      organizationId: ORG,
      projectId: '',
    });
  });

  it('ignores extra keys', () => {
    expect(
      tenantSettings({ organizationId: ORG, projectId: PROJECT, role: 'admin' }, 'project'),
    ).toEqual({ organizationId: ORG, projectId: PROJECT });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', ORG],
    ['an empty object', {}],
    ['an empty organization', { organizationId: '' }],
    ['a blank organization', { organizationId: '   ' }],
    ['a null organization', { organizationId: null }],
    ['a numeric organization', { organizationId: 1 }],
    ['an organization that is not a UUID', { organizationId: 'org_123' }],
    ['an uppercase organization', { organizationId: ORG.toUpperCase() }],
    ['an organization with spaces', { organizationId: ` ${ORG}` }],
    ['a public id', { organizationId: 'org_01k7a0000000000000000000' }],
    // An empty project must never widen a project transaction to the whole organization.
    ['an empty project', { organizationId: ORG, projectId: '' }],
    ['a null project', { organizationId: ORG, projectId: null }],
    ['a project that is not a UUID', { organizationId: ORG, projectId: 'prj' }],
    ['a project without an organization', { projectId: PROJECT }],
    ['an organization smuggling a setting', { organizationId: `${ORG}', true) --` }],
  ])('refuses %s with DB_TENANT_CONTEXT_MISSING', (_label, ctx) => {
    expect(code(() => tenantSettings(ctx, 'organization'))).toBe('DB_TENANT_CONTEXT_MISSING');
  });

  it('refuses an OrganizationRef where a project is required', () => {
    expect(code(() => tenantSettings({ organizationId: ORG }, 'project'))).toBe(
      'DB_TENANT_CONTEXT_MISSING',
    );
  });

  it('reads the ids once, so a getter cannot change them between check and use', () => {
    let reads = 0;
    const ctx = {
      get organizationId() {
        reads += 1;
        return reads === 1 ? ORG : 'not-a-uuid';
      },
    };
    expect(tenantSettings(ctx, 'organization')).toEqual({ organizationId: ORG, projectId: '' });
  });
});

describe('transactionTimeout', () => {
  it('falls back when none is given', () => {
    expect(transactionTimeout(undefined, 5000)).toBe(5000);
  });

  it.each([1, 100, 2000, 60_000])('takes %i ms', (ms) => {
    expect(transactionTimeout(ms, 5000)).toBe(ms);
  });

  // Zero is no timeout to Postgres, which turns a bounded failure into a hang.
  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a string', '100'],
    ['null', null],
    ['above one hour', 3_600_001],
  ])('refuses %s with DB_CONFIG_INVALID', (_label, ms) => {
    expect(code(() => transactionTimeout(ms, 5000))).toBe('DB_CONFIG_INVALID');
  });
});
