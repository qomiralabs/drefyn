import { describe, expect, it } from 'vitest';
import { ID_KINDS, TenancyError, idOf, organizationId, projectId } from '../src/index.ts';
import { MAX_UUID, NIL_UUID, PREFIXES, expectCode } from './support.ts';

const V7 = '01928c3e-7a9b-7c3d-8e4f-0123456789ab';
const V4 = '9b2f6a1e-4c3d-4b8a-9f7e-6d5c4b3a2918';

const notUuids: readonly [string, unknown][] = [
  ['empty', ''],
  ['uppercase', V7.toUpperCase()],
  ['one uppercase letter', '01928C3e-7a9b-7c3d-8e4f-0123456789ab'],
  ['no hyphens', V7.replaceAll('-', '')],
  ['braces', `{${V7}}`],
  ['urn form', `urn:uuid:${V7}`],
  ['leading space', ` ${V7}`],
  ['trailing space', `${V7} `],
  ['trailing newline', `${V7}\n`],
  ['leading newline', `\n${V7}`],
  ['one short', V7.slice(0, -1)],
  ['one long', `${V7}0`],
  ['hyphen moved', '01928c3e7-a9b-7c3d-8e4f-0123456789ab'],
  ['non hex letter', '01928c3e-7a9b-7c3d-8e4f-0123456789ag'],
  ['public id form', 'org_01arz3ndektsv4rrffq69g5fav'],
  ['fullwidth digit', '\uff101928c3e-7a9b-7c3d-8e4f-0123456789ab'],
  ['nul byte', `${V7.slice(0, -1)}\u0000`],
  ['number', 42],
  ['null', null],
  ['undefined', undefined],
  ['object', { toString: () => V7 }],
  ['boxed string', new String(V7)],
  ['array', [V7]],
];

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
