import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readRoleFacts } from '../src/role-check.ts';
import { rejected } from './support.ts';

function clientReturning(rows: Record<string, unknown>[]): pg.ClientBase {
  return { query: () => Promise.resolve({ rows }) } as unknown as pg.ClientBase;
}

const row = {
  current_user_name: 'drefyn_app',
  superuser: false,
  bypass_rls: false,
  owned_tables: [],
  member_of: [],
  role_settings: ['|search_path=public', 'drefyn|statement_timeout=0\u001fwork_mem=64MB'],
  database_settings: ['search_path=app, extensions'],
};

describe('readRoleFacts', () => {
  it('splits settings per database, with an empty name meaning every database', async () => {
    expect(await readRoleFacts(clientReturning([row]))).toEqual({
      currentUser: 'drefyn_app',
      superuser: false,
      bypassRls: false,
      ownedTables: [],
      memberOf: [],
      settings: [
        { database: null, settings: ['search_path=public'] },
        { database: 'drefyn', settings: ['statement_timeout=0', 'work_mem=64MB'] },
      ],
      databaseSettings: ['search_path=app, extensions'],
    });
  });

  // Refusing to start beats starting on facts that were never read.
  it.each<[string, Record<string, unknown>[]]>([
    ['no row', []],
    ['no current user', [{ ...row, current_user_name: null }]],
    ['a flag that is not a boolean', [{ ...row, superuser: 'f' }]],
    ['a list that is not text', [{ ...row, owned_tables: [1] }]],
    ['a list that is not a list', [{ ...row, member_of: 'drefyn_owner' }]],
  ])('fails on %s', async (_label, rows) => {
    expect(String(await rejected(readRoleFacts(clientReturning(rows))))).toMatch(/role check/);
  });
});
