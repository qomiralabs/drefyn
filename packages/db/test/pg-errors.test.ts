import { describe, expect, it } from 'vitest';
import { DbError } from '../src/errors.ts';
import { toDbError } from '../src/pg-errors.ts';
import { errorText } from './support.ts';

// The shape pg gives a server error: an Error with the SQLSTATE and the server's fields.
function serverError(code: string, message: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...fields });
}

function mapped(error: unknown): DbError {
  const result = toDbError(error);
  if (!(result instanceof DbError)) throw new Error(`expected a DbError, got ${String(result)}`);
  return result;
}

describe('toDbError', () => {
  it('maps a policy violation to DB_RLS_VIOLATION', () => {
    const error = serverError(
      '42501',
      'new row violates row-level security policy for table "fixture_notes"',
    );
    expect(mapped(error).code).toBe('DB_RLS_VIOLATION');
  });

  // A missing grant is a different failure from a policy, and saying RLS would mislead.
  it('leaves a plain permission error as it was', () => {
    const error = serverError('42501', 'permission denied for table fixture_drafts');
    expect(toDbError(error)).toBe(error);
  });

  it('maps a unique violation to DB_UNIQUE_VIOLATION without the key values', () => {
    const error = serverError(
      '23505',
      'duplicate key value violates unique constraint "fixture_notes_organization_id_slug_key"',
      {
        detail:
          'Key (organization_id, slug)=(01a14984-4476-77ce-9335-2c3c3a59aa8b, secret-launch) already exists.',
        constraint: 'fixture_notes_organization_id_slug_key',
        table: 'fixture_notes',
      },
    );
    const result = mapped(error);
    expect(result.code).toBe('DB_UNIQUE_VIOLATION');
    expect(result.message).toContain('fixture_notes_organization_id_slug_key');
    const text = errorText(result);
    expect(text).not.toContain('secret-launch');
    expect(text).not.toContain('01a14984-4476-77ce-9335-2c3c3a59aa8b');
  });

  it.each([
    ['57014', 'canceling statement due to statement timeout'],
    ['55P03', 'canceling statement due to lock timeout'],
    ['25P03', 'terminating connection due to idle-in-transaction timeout'],
  ])('maps %s to DB_TIMEOUT', (code, message) => {
    expect(mapped(serverError(code, message)).code).toBe('DB_TIMEOUT');
  });

  it.each([
    ['57P01', 'terminating connection due to administrator command'],
    ['57P03', 'the database system is starting up'],
    ['08006', 'connection failure'],
    ['08001', 'could not connect'],
    ['53300', 'sorry, too many clients already'],
  ])('maps %s to DB_UNAVAILABLE', (code, message) => {
    expect(mapped(serverError(code, message)).code).toBe('DB_UNAVAILABLE');
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'])(
    'maps the socket error %s to DB_UNAVAILABLE',
    (code) => {
      const error = Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code });
      expect(mapped(error).code).toBe('DB_UNAVAILABLE');
    },
  );

  it('maps the pool wait running out to DB_UNAVAILABLE', () => {
    expect(mapped(new Error('timeout exceeded when trying to connect')).code).toBe(
      'DB_UNAVAILABLE',
    );
  });

  it.each([
    ['28P01', 'password authentication failed for user "drefyn_app"'],
    ['28000', 'no pg_hba.conf entry for host'],
    ['3D000', 'database "nope" does not exist'],
  ])('maps %s to DB_CONFIG_INVALID, since retrying cannot help', (code, message) => {
    expect(mapped(serverError(code, message)).code).toBe('DB_CONFIG_INVALID');
  });

  it('passes a DbError through unchanged', () => {
    const error = new DbError('INTEGER_INVALID', 'amount_cents is not a safe integer');
    expect(toDbError(error)).toBe(error);
  });

  it.each([
    ['an error from the work', new Error('the caller threw this')],
    ['a syntax error', serverError('42601', 'syntax error at or near "selec"')],
    ['a check violation', serverError('23514', 'violates check constraint')],
    ['a string', 'thrown string'],
    ['undefined', undefined],
  ])('leaves %s as it was', (_label, error) => {
    expect(toDbError(error)).toBe(error);
  });

  it('never carries the server detail, hint, where or the query values', () => {
    const error = serverError('57014', 'canceling statement due to statement timeout', {
      detail: 'private detail',
      hint: 'private hint',
      where: 'SQL statement "select private_where"',
      internalQuery: 'select private_internal',
    });
    const text = errorText(mapped(error));
    for (const leak of ['private detail', 'private hint', 'private_where', 'private_internal']) {
      expect(text).not.toContain(leak);
    }
  });
});
