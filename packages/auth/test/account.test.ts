import { describe, expect, it } from 'vitest';
import { createAccount } from '../src/index.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { USER, capturingLogger, sessionInfo } from './session-fixtures.ts';

const AT = new Date('2026-10-03T09:00:00.000Z');
const SET = new Date('2026-10-14T09:00:00.000Z');
const from = (s: Statement, table: string) => s.sql.includes(`from "${table}"`);

interface World {
  readonly user?: boolean;
  readonly password?: boolean;
  readonly updated?: boolean;
  readonly fail?: boolean;
}

function setup(w: World = {}) {
  const store = scriptedStore((s) => {
    if (w.fail === true) throw new Error('down');
    if (s.sql.startsWith('update "users"')) {
      return w.updated === false ? [] : [{ display_name: s.parameters[0] }];
    }
    if (from(s, 'users') && s.sql.includes('email_verified_at')) {
      return [{ email_verified_at: AT }];
    }
    if (from(s, 'users')) {
      return w.user === false ? [] : [{ email: 'maya@acme.dev', display_name: 'Maya Okafor' }];
    }
    if (from(s, 'password_credentials')) {
      return w.password === false ? [] : [{ updated_at: SET }];
    }
    if (from(s, 'identities')) {
      return [{ provider: 'github', provider_email_normalized: 'maya@acme.dev', created_at: AT }];
    }
    return [];
  });
  const { logger, lines } = capturingLogger();
  return { account: createAccount({ store: store.store, logger }), store, lines };
}

describe('readAccount', () => {
  it('reads the name, address, password date and linked providers', async () => {
    const { account } = setup();
    const read = await account.readAccount(sessionInfo());
    expect(read).toEqual({
      ok: true,
      value: {
        displayName: 'Maya Okafor',
        email: 'maya@acme.dev',
        confirmedAt: AT,
        passwordSetAt: SET,
        identities: [{ provider: 'github', account: 'maya@acme.dev', linkedAt: AT }],
      },
    });
  });

  it('never selects the password hash', async () => {
    const { account, store } = setup();
    await account.readAccount(sessionInfo());
    const sql = store.statements().map((s) => s.sql);
    expect(sql.some((s) => s.includes('password_credentials'))).toBe(true);
    expect(sql.join('\n')).not.toContain('"phc"');
  });

  it('reads with no password as a null date', async () => {
    const { account } = setup({ password: false });
    const read = await account.readAccount(sessionInfo());
    expect(read.ok && read.value.passwordSetAt).toBeNull();
  });

  it('answers a session whose person is gone as invalid', async () => {
    const { account } = setup({ user: false });
    const read = await account.readAccount(sessionInfo());
    expect(!read.ok && read.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('turns a database failure into unavailable', async () => {
    const { account } = setup({ fail: true });
    const read = await account.readAccount(sessionInfo());
    expect(!read.ok && read.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('setDisplayName', () => {
  it('saves the name as the person typed it, trimmed', async () => {
    const { account, lines } = setup();
    const done = await account.setDisplayName(sessionInfo(), { name: '  Maya O  ' });
    expect(done).toEqual({ ok: true, value: { displayName: 'Maya O' } });
    expect(lines.some((l) => l.event === 'auth.display_name_changed')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('Maya');
  });

  it.each([[''], ['   '], ['visit evil.example'], ['x'.repeat(101)]])(
    'refuses %j before any statement',
    async (name) => {
      const { account, store } = setup();
      const done = await account.setDisplayName(sessionInfo(), { name });
      expect(!done.ok && done.error.code).toBe('AUTH_INPUT_INVALID');
      expect(store.statements()).toEqual([]);
    },
  );

  it('answers a missing row as an invalid session', async () => {
    const { account } = setup({ updated: false });
    const done = await account.setDisplayName(sessionInfo(), { name: 'Maya' });
    expect(!done.ok && done.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('runs as the person, on their own row', async () => {
    const { account, store } = setup();
    await account.setDisplayName(sessionInfo(), { name: 'Maya' });
    const update = store.statements().find((s) => s.sql.startsWith('update "users"'));
    expect(update?.parameters).toContain(USER);
    expect(update?.sql).not.toContain('email');
  });
});
