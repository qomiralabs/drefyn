import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import {
  POOL_ROLES,
  assertRoleSafe,
  roleProblems,
  type PoolKind,
  type RoleFacts,
} from '../src/role-check.ts';
import { thrown } from './support.ts';

function facts(overrides: Partial<RoleFacts> = {}): RoleFacts {
  return {
    currentUser: 'drefyn_app',
    superuser: false,
    bypassRls: false,
    ownedTables: [],
    memberOf: [],
    settings: [],
    databaseSettings: ['search_path=app, extensions'],
    clusterSettings: [],
    ...overrides,
  };
}

const reader = (overrides: Partial<RoleFacts> = {}) =>
  facts({ currentUser: 'drefyn_public_reader', ...overrides });

const auth = (overrides: Partial<RoleFacts> = {}) =>
  facts({ currentUser: 'drefyn_auth', ...overrides });

describe('POOL_ROLES', () => {
  it('names one role per pool, the pre sign in role included', () => {
    expect(POOL_ROLES).toEqual({
      app: 'drefyn_app',
      reader: 'drefyn_public_reader',
      auth: 'drefyn_auth',
    });
  });
});

describe('roleProblems', () => {
  it('passes drefyn_app on the app pool and the reader on the reader pool', () => {
    expect(roleProblems(facts(), 'app')).toEqual([]);
    expect(roleProblems(reader(), 'reader')).toEqual([]);
  });

  it('passes drefyn_auth on the auth pool', () => {
    expect(roleProblems(auth(), 'auth')).toEqual([]);
  });

  it.each<[string, RoleFacts, PoolKind, RegExp]>([
    ['a superuser', facts({ superuser: true }), 'app', /superuser/i],
    ['a BYPASSRLS role', facts({ bypassRls: true }), 'app', /bypassrls/i],
    ['a reader with BYPASSRLS', reader({ bypassRls: true }), 'reader', /bypassrls/i],
    [
      'the owner of app tables',
      facts({ ownedTables: ['app.fixture_notes'] }),
      'app',
      /owns.*app\.fixture_notes/i,
    ],
    [
      'the reader on the app pool',
      reader(),
      'app',
      /drefyn_app.*drefyn_public_reader|drefyn_public_reader.*drefyn_app/,
    ],
    [
      'the app role on the reader pool',
      facts(),
      'reader',
      /drefyn_public_reader.*drefyn_app|drefyn_app.*drefyn_public_reader/,
    ],
    ['the auth role on the app pool', auth(), 'app', /drefyn_app.*drefyn_auth/],
    ['the app role on the auth pool', facts(), 'auth', /drefyn_auth.*drefyn_app/],
    ['the reader on the auth pool', reader(), 'auth', /drefyn_auth.*drefyn_public_reader/],
    ['an auth role with BYPASSRLS', auth({ bypassRls: true }), 'auth', /bypassrls/i],
    ['an auth role that is a superuser', auth({ superuser: true }), 'auth', /superuser/i],
    [
      'an auth role that is a member of drefyn_app',
      auth({ memberOf: ['drefyn_app'] }),
      'auth',
      /member.*drefyn_app/i,
    ],
    [
      'an auth role with a role setting',
      auth({ settings: [{ database: null, settings: ['search_path=public'] }] }),
      'auth',
      /role setting.*search_path/,
    ],
    ['drefyn_owner on the app pool', facts({ currentUser: 'drefyn_owner' }), 'app', /drefyn_owner/],
    [
      'postgres on the app pool',
      facts({ currentUser: 'postgres', superuser: true }),
      'app',
      /postgres/,
    ],
    // NOINHERIT still lets a member SET ROLE to whatever it was granted.
    [
      'a member of drefyn_owner',
      facts({ memberOf: ['drefyn_owner'] }),
      'app',
      /member.*drefyn_owner/i,
    ],
    [
      'a role setting for every database',
      facts({ settings: [{ database: null, settings: ['search_path=public'] }] }),
      'app',
      /search_path/,
    ],
    [
      'a role setting for one database',
      facts({ settings: [{ database: 'drefyn', settings: ['statement_timeout=0'] }] }),
      'app',
      /statement_timeout.*drefyn|drefyn.*statement_timeout/,
    ],
    [
      'a reader set role setting',
      reader({ settings: [{ database: null, settings: ['role=drefyn_public_reader'] }] }),
      'reader',
      /role=drefyn_public_reader/,
    ],
  ])('refuses %s', (_label, input, pool, reason) => {
    const problems = roleProblems(input, pool);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(reason);
  });

  it('allows no database setting at all', () => {
    expect(roleProblems(facts({ databaseSettings: [] }), 'app')).toEqual([]);
  });

  // A database setting follows every connection, so only the bootstrap's search_path is
  // expected, and a default tenant must never come from one.
  it.each([
    ['another search_path', 'search_path=public', /search_path=public/],
    ['a longer search_path', 'search_path=app, extensions, public', /search_path/],
    [
      'a default organization',
      'drefyn.organization_id=01a14984-4476-77ce-9335-00000000000a',
      /drefyn\.organization_id/,
    ],
    [
      'a default project',
      'drefyn.project_id=01a14984-4476-77ce-9335-0000000000a1',
      /drefyn\.project_id/,
    ],
    ['an empty drefyn setting', 'drefyn.organization_id=', /drefyn\.organization_id/],
    ['any other setting', 'work_mem=64MB', /work_mem/],
    ['statement_timeout off', 'statement_timeout=0', /statement_timeout/],
  ])('refuses %s set on the database', (_label, setting, reason) => {
    for (const [pool, input] of [
      ['app', facts({ databaseSettings: ['search_path=app, extensions', setting] })],
      ['reader', reader({ databaseSettings: [setting] })],
    ] as const) {
      const problems = roleProblems(input, pool);
      expect(problems.join('\n'), pool).toMatch(reason);
      expect(problems.join('\n'), pool).toMatch(/database/i);
    }
  });

  // alter role all set ... applies to every role in every database, the pools included.
  it.each([
    ['search_path=public', /search_path=public/],
    ['search_path=app, extensions', /search_path=app, extensions/],
    ['drefyn.organization_id=x', /drefyn\.organization_id/],
  ])('refuses %s set for all roles', (setting, reason) => {
    for (const [pool, input] of [
      ['app', facts({ clusterSettings: [setting] })],
      ['reader', reader({ clusterSettings: [setting] })],
    ] as const) {
      const text = roleProblems(input, pool).join('\n');
      expect(text, pool).toMatch(reason);
      expect(text, pool).toMatch(/every role/);
    }
  });

  it('lists every problem, not only the first', () => {
    const problems = roleProblems(
      facts({
        currentUser: 'drefyn_owner',
        superuser: true,
        bypassRls: true,
        ownedTables: ['app.a', 'app.b'],
        settings: [{ database: null, settings: ['search_path=public'] }],
      }),
      'app',
    );
    const text = problems.join('\n');
    for (const part of [
      /superuser/i,
      /bypassrls/i,
      /app\.a/,
      /app\.b/,
      /search_path/,
      /drefyn_owner/,
    ]) {
      expect(text).toMatch(part);
    }
  });

  it('treats a settings entry with no settings as clean', () => {
    expect(roleProblems(facts({ settings: [{ database: null, settings: [] }] }), 'app')).toEqual(
      [],
    );
  });
});

describe('assertRoleSafe', () => {
  it('returns for a safe role', () => {
    expect(() => {
      assertRoleSafe(facts(), 'app');
    }).not.toThrow();
  });

  it('throws DB_ROLE_UNSAFE naming each problem', () => {
    const error = thrown(() => {
      assertRoleSafe(facts({ superuser: true, ownedTables: ['app.fixture_notes'] }), 'app');
    });
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_ROLE_UNSAFE');
    expect((error as DbError).message).toMatch(/superuser/i);
    expect((error as DbError).message).toContain('app.fixture_notes');
  });
});
