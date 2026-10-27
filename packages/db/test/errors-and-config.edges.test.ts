import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { toDbError } from '../src/pg-errors.ts';
import { thrown } from './support.ts';

function unique(fields: Record<string, string>): DbError {
  const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    ...fields,
  });
  const mapped = toDbError(error);
  if (!(mapped instanceof DbError)) throw new Error('expected a DbError');
  return mapped;
}

describe('toDbError on a unique violation', () => {
  it.each([
    ['no constraint name', {}],
    ['a constraint name that is not a plain identifier', { constraint: 'a"; select secret --' }],
  ])('uses fixed text for %s', (_label, fields) => {
    const mapped = unique(fields);
    expect(mapped.code).toBe('DB_UNIQUE_VIOLATION');
    expect(mapped.message).toBe('a unique constraint refused the write (23505)');
  });
});

describe('parseDatabaseConfig URL edges', () => {
  const message = (url: string) => {
    const error = thrown(() => parseDatabaseConfig({ DREFYN_DATABASE_URL: url }));
    expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
    return (error as DbError).message;
  };

  it('refuses a URL with no host', () => {
    expect(message('postgres:///drefyn')).toContain('has no host');
  });

  it('refuses a fragment', () => {
    expect(message('postgres://drefyn_app:x@127.0.0.1/drefyn#frag')).toContain('fragment');
  });

  it('names an odd parameter key without repeating it', () => {
    const text = message('postgres://drefyn_app:x@127.0.0.1/drefyn?pass-word=hunter2');
    expect(text).toContain('an unnamed parameter');
    expect(text).not.toContain('pass-word');
    expect(text).not.toContain('hunter2');
  });
});
