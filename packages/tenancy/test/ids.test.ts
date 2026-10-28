import { describe, expect, it } from 'vitest';
import { ID_KINDS, TenancyError, idOf, organizationId, projectId } from '../src/index.ts';
import {
  MAX_UUID,
  NIL_UUID,
  NOT_UUIDS as notUuids,
  PREFIXES,
  V4,
  V7,
  expectCode,
} from './support.ts';

describe('organizationId and projectId', () => {
  it.each([
    ['UUIDv7', V7],
    ['UUIDv4', V4],
    ['nil', NIL_UUID],
    ['max', MAX_UUID],
  ])('accept a canonical %s and return it unchanged', (_label, value) => {
    expect(organizationId(value)).toBe(value);
    expect(projectId(value)).toBe(value);
  });

  it.each(notUuids)('reject %s with ID_MALFORMED', (_label, value) => {
    expectCode(() => organizationId(value as string), 'ID_MALFORMED');
    expectCode(() => projectId(value as string), 'ID_MALFORMED');
  });

  it('throws a TenancyError that is an Error with a stable name', () => {
    let caught: unknown;
    try {
      organizationId('nope');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TenancyError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as TenancyError).name).toBe('TenancyError');
    expect((caught as TenancyError).code).toBe('ID_MALFORMED');
  });

  it('does not echo rejected input in the error message', () => {
    const hostile = `x\n${'<script>'.repeat(64)}`;
    let message = '';
    try {
      organizationId(hostile);
    } catch (error) {
      expect(error).toBeInstanceOf(TenancyError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('<script>');
    expect(message.length).toBeLessThan(200);
  });

  it('rejects a megabyte of input without hanging', () => {
    expectCode(() => organizationId('0'.repeat(1_000_000)), 'ID_MALFORMED');
    expectCode(() => projectId(`${V7}${'-'.repeat(1_000_000)}`), 'ID_MALFORMED');
  });
});

describe('idOf', () => {
  it('lists exactly the initial prefixes, in order', () => {
    expect([...ID_KINDS]).toEqual([...PREFIXES]);
  });

  it('keeps ID_KINDS frozen so no caller can add a kind at run time', () => {
    expect(Array.isArray(ID_KINDS)).toBe(true);
    expect(Object.isFrozen(ID_KINDS)).toBe(true);
  });

  it('has unique three letter lowercase prefixes', () => {
    expect(new Set(ID_KINDS).size).toBe(ID_KINDS.length);
    for (const kind of ID_KINDS) expect(kind).toMatch(/^[a-z]{3}$/);
  });

  it.each(PREFIXES)('brands a canonical UUID as a %s id', (kind) => {
    expect(idOf(kind, V7)).toBe(V7);
  });

  it('agrees with the named constructors', () => {
    expect(idOf('org', V7)).toBe(organizationId(V7));
    expect(idOf('prj', V7)).toBe(projectId(V7));
  });

  it.each(notUuids)('rejects %s with ID_MALFORMED for every kind', (_label, value) => {
    for (const kind of ID_KINDS) expectCode(() => idOf(kind, value as string), 'ID_MALFORMED');
  });

  it.each(['', 'ORG', 'organization', 'xyz', 'org_', '__proto__', 'constructor', 'toString'])(
    'refuses unknown kind %j at run time',
    (kind) => {
      expectCode(() => idOf(kind as 'org', V7), 'ID_KIND_UNKNOWN');
    },
  );
});
