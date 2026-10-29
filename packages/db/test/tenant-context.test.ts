import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import {
  APP_TIMEOUT_MAX_MS,
  READER_TIMEOUT_MAX_MS,
  organizationSettings,
  projectSettings,
  transactionTimeout,
} from '../src/tenant-context.ts';
import { thrown } from './support.ts';

const ORG = '01a14984-4476-77ce-9335-2c3c3a59aa8b';
const PROJECT = '01a14984-4476-77ce-9335-2c3c3a59aa8c';

function code(fn: () => unknown): string {
  const error = thrown(fn);
  return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`;
}

const withGetter = (key: string, value: string, base: object = {}) =>
  Object.defineProperty({ ...base }, key, { get: () => value, enumerable: true });

describe('projectSettings', () => {
  it('takes a TenantRef as both settings, with an empty user', () => {
    expect(projectSettings({ organizationId: ORG, projectId: PROJECT })).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
      userId: '',
    });
  });

  it('takes a null prototype object', () => {
    const ctx = Object.assign(Object.create(null) as object, {
      organizationId: ORG,
      projectId: PROJECT,
    });
    expect(projectSettings(ctx)).toEqual({ organizationId: ORG, projectId: PROJECT, userId: '' });
  });

  // A project transaction must never quietly become an organization one.
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a string', ORG],
    ['an empty object', {}],
    ['an OrganizationRef', { organizationId: ORG }],
    ['a projectId of undefined', { organizationId: ORG, projectId: undefined }],
    ['an empty project', { organizationId: ORG, projectId: '' }],
    ['a null project', { organizationId: ORG, projectId: null }],
    ['a project that is not a UUID', { organizationId: ORG, projectId: 'prj' }],
    ['an uppercase project', { organizationId: ORG, projectId: PROJECT.toUpperCase() }],
    ['a project without an organization', { projectId: PROJECT }],
    ['an empty organization', { organizationId: '', projectId: PROJECT }],
    ['a public id', { organizationId: 'org_01k7a0000000000000000000', projectId: PROJECT }],
    [
      'an organization smuggling a setting',
      { organizationId: `${ORG}', true) --`, projectId: PROJECT },
    ],
    ['a project from a getter', withGetter('projectId', PROJECT, { organizationId: ORG })],
    ['an organization from a getter', withGetter('organizationId', ORG, { projectId: PROJECT })],
  ])('refuses %s with DB_TENANT_CONTEXT_MISSING', (_label, ctx) => {
    expect(code(() => projectSettings(ctx))).toBe('DB_TENANT_CONTEXT_MISSING');
  });

  it.each<[string, unknown]>([
    ['an extra field', { organizationId: ORG, projectId: PROJECT, role: 'admin' }],
    ['an extra getter', withGetter('role', 'admin', { organizationId: ORG, projectId: PROJECT })],
    [
      'a class instance',
      new (class {
        organizationId = ORG;
        projectId = PROJECT;
      })(),
    ],
    ['an array', [ORG, PROJECT]],
    [
      'ids from the prototype',
      Object.create({ organizationId: ORG, projectId: PROJECT }) as object,
    ],
  ])('refuses %s with DB_TENANT_CONTEXT_INVALID', (_label, ctx) => {
    expect(code(() => projectSettings(ctx))).toBe('DB_TENANT_CONTEXT_INVALID');
  });
});

describe('organizationSettings', () => {
  // The project is always set, to empty here, so nothing left on the session can stand in.
  it('takes an OrganizationRef with an empty project and user', () => {
    expect(organizationSettings({ organizationId: ORG })).toEqual({
      organizationId: ORG,
      projectId: '',
      userId: '',
    });
  });

  // Organization scope has to be asked for: a TenantRef that lost its project, or one
  // widened to an OrganizationRef, must not land here.
  it.each<[string, unknown]>([
    ['a TenantRef', { organizationId: ORG, projectId: PROJECT }],
    ['a projectId of undefined', { organizationId: ORG, projectId: undefined }],
    ['an empty project', { organizationId: ORG, projectId: '' }],
    ['a project from a getter', withGetter('projectId', PROJECT, { organizationId: ORG })],
    ['an extra field', { organizationId: ORG, role: 'admin' }],
  ])('refuses %s with DB_TENANT_CONTEXT_INVALID', (_label, ctx) => {
    expect(code(() => organizationSettings(ctx))).toBe('DB_TENANT_CONTEXT_INVALID');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an empty object', {}],
    ['an empty organization', { organizationId: '' }],
    ['an organization that is not a UUID', { organizationId: 'org_123' }],
    ['an organization from a getter', withGetter('organizationId', ORG)],
  ])('refuses %s with DB_TENANT_CONTEXT_MISSING', (_label, ctx) => {
    expect(code(() => organizationSettings(ctx))).toBe('DB_TENANT_CONTEXT_MISSING');
  });
});

describe('transactionTimeout', () => {
  it('has a 60 s ceiling for withTenant and 10 s for the reader', () => {
    expect(APP_TIMEOUT_MAX_MS).toBe(60_000);
    expect(READER_TIMEOUT_MAX_MS).toBe(10_000);
  });

  it('falls back when none is given', () => {
    expect(transactionTimeout(undefined, 5000, APP_TIMEOUT_MAX_MS)).toBe(5000);
    expect(transactionTimeout(undefined, 2000, READER_TIMEOUT_MAX_MS)).toBe(2000);
  });

  it.each([1, 100, 2000, 60_000])('takes %i ms for withTenant', (ms) => {
    expect(transactionTimeout(ms, 5000, APP_TIMEOUT_MAX_MS)).toBe(ms);
  });

  it.each([1, 2000, 10_000])('takes %i ms for the reader', (ms) => {
    expect(transactionTimeout(ms, 2000, READER_TIMEOUT_MAX_MS)).toBe(ms);
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
    ['above 60 s', 60_001],
    ['above the Postgres limit', 2 ** 31],
  ])('refuses %s for withTenant with DB_CONFIG_INVALID', (_label, ms) => {
    expect(code(() => transactionTimeout(ms, 5000, APP_TIMEOUT_MAX_MS))).toBe('DB_CONFIG_INVALID');
  });

  it.each([
    ['above 10 s', 10_001],
    ['the withTenant ceiling', 60_000],
    ['zero', 0],
  ])('refuses %s for the reader with DB_CONFIG_INVALID', (_label, ms) => {
    expect(code(() => transactionTimeout(ms, 2000, READER_TIMEOUT_MAX_MS))).toBe(
      'DB_CONFIG_INVALID',
    );
  });
});
