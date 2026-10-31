import { idOf, toPublicId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { serializeCookie, type CookieSpec } from '../src/index.ts';
import {
  NEW_SECRET,
  NEW_SESSION,
  OTHER_SESSION,
  SECRET,
  SESSION,
  USER,
  browser,
  config,
  isDelete,
  isInsert,
  isLock,
  lockRow,
  loopbackConfig,
  sessionInfo,
  sessionResponder,
  sessionRow,
  setup,
  sha,
  tokenFor,
} from './session-fixtures.ts';
import type { Responder, Statement } from './scripted-store.ts';

function rotation(
  rows: readonly Record<string, unknown>[],
  opts: { readonly failDelete?: boolean } = {},
): Responder {
  return (statement) => {
    if (isLock(statement)) return rows;
    if (isInsert(statement)) return [{ id: NEW_SESSION }];
    if (isDelete(statement)) {
      if (opts.failDelete === true) throw new Error('delete failed');
      return rows.map((row) => ({ id: row['id'] }));
    }
    return [];
  };
}

// The lock read ends in for update, so the store's own write check would count it.
const changes = (statements: readonly Statement[]) =>
  statements.filter((s) => isInsert(s) || isDelete(s));

const sessionCookie = (cookies: readonly CookieSpec[], name = config.cookies.session) =>
  cookies.find((c) => c.name === name);

describe('signOutOtherSessions', () => {
  it('locks, inserts the new row, deletes every other row and commits, in one transaction', async () => {
    const { sessions, scripted } = setup(
      rotation([lockRow(), lockRow({ id: OTHER_SESSION, recent: false })]),
    );
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(result).toMatchObject({ ok: true, value: { revoked: 1 } });
    expect(scripted.events.map((e) => e.kind)).toEqual([
      'begin',
      'statement',
      'statement',
      'statement',
      'commit',
    ]);
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
    const [lock, insert, del] = scripted.statements();
    expect(lock && isLock(lock)).toBe(true);
    expect(lock?.sql).toMatch(
      /where "user_id" = app\.current_user_id\(\) order by "id" for update$/,
    );
    expect(insert && isInsert(insert)).toBe(true);
    expect(del && isDelete(del)).toBe(true);
    expect(del?.sql).toMatch(/"user_id" = app\.current_user_id\(\)/);
    expect(del?.sql).toMatch(/"id" <> \$1/);
    expect(del?.parameters).toEqual([NEW_SESSION]);
  });

  it('copies method, step up, authenticated_at, user_agent and expires_at from the old row in the database', async () => {
    const { sessions, scripted } = setup(rotation([lockRow()]));
    await sessions.signOutOtherSessions(sessionInfo(), browser());
    const insert = scripted.statements().find(isInsert);
    // Copied by insert ... select, so the database keeps its own microseconds.
    expect(insert?.sql).toMatch(
      /^insert into "sessions" \("user_id", "secret_hash", "method", "step_up_method", "authenticated_at", "last_seen_at", "expires_at", "user_agent"\) select "user_id", \$1 as "secret_hash", "method", "step_up_method", "authenticated_at", now\(\) as "last_seen_at", "expires_at", "user_agent" from "sessions" where "id" = \$2 and "user_id" = app\.current_user_id\(\) returning "id"$/,
    );
    expect(insert?.parameters[0]).toEqual(sha(NEW_SECRET));
    expect(insert?.parameters[1]).toBe(SESSION);
    expect(insert?.parameters).not.toContainEqual(sha(SECRET));
    expect(insert?.sql).not.toMatch(/make_interval|\+ interval/);
  });

  it('counts only the other sessions as revoked', async () => {
    const alone = setup(rotation([lockRow()]));
    await expect(
      alone.sessions.signOutOtherSessions(sessionInfo(), browser()),
    ).resolves.toMatchObject({ ok: true, value: { revoked: 0 } });
    const many = setup(
      rotation([
        lockRow(),
        lockRow({ id: OTHER_SESSION }),
        lockRow({ id: idOf('ses', '01890a5d-ac96-774b-bcce-b302099a8062') }),
      ]),
    );
    await expect(
      many.sessions.signOutOtherSessions(sessionInfo(), browser()),
    ).resolves.toMatchObject({ ok: true, value: { revoked: 2 } });
  });

  it('sets a new session cookie for the new row, with Max-Age equal to the seconds left', async () => {
    const { sessions } = setup(rotation([lockRow({ secondsLeft: 2_591_000 })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    if (!result.ok) throw result.error;
    const cookie = sessionCookie(result.value.setCookies);
    expect(cookie).toEqual({
      name: config.cookies.session,
      value: tokenFor(USER, NEW_SESSION, NEW_SECRET),
      maxAgeSeconds: 2_591_000,
    });
    expect(cookie?.value).not.toBe(tokenFor());
    const header = serializeCookie(config, cookie ?? { name: '', value: '', maxAgeSeconds: 0 });
    expect(header).toBe(
      `__Host-drefyn_session=${tokenFor(USER, NEW_SESSION, NEW_SECRET)}; Path=/; Max-Age=2591000; HttpOnly; Secure; SameSite=Lax`,
    );
    // Nothing in the list clears the cookie it just set.
    expect(result.value.setCookies.filter((c) => c.maxAgeSeconds === 0)).toEqual([]);
  });

  it('uses the bare cookie name on the loopback setup', async () => {
    const { sessions } = setup(rotation([lockRow()]), {}, loopbackConfig);
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    if (!result.ok) throw result.error;
    expect(sessionCookie(result.value.setCookies, 'drefyn_session')).toBeDefined();
  });

  it('refuses a sign in older than 15 minutes with AUTH_RECENT_AUTH_REQUIRED and writes nothing', async () => {
    const { sessions, scripted } = setup(rotation([lockRow({ recent: false })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(changes(scripted.statements())).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    // The database clock decides, not the app's copy of authenticated_at.
    expect(scripted.statements()[0]?.sql).toMatch(
      /authenticated_at > now\(\) - interval '15 minutes'/,
    );
  });

  it('refuses with AUTH_SESSION_INVALID and writes nothing when the current row is gone', async () => {
    const { sessions, scripted } = setup(rotation([lockRow({ id: OTHER_SESSION })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
    expect(changes(scripted.statements())).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('refuses with AUTH_SESSION_INVALID when the current row is past its idle or absolute limit', async () => {
    const { sessions, scripted } = setup(rotation([lockRow({ live: false, recent: true })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
    expect(changes(scripted.statements())).toEqual([]);
  });

  it('refuses with AUTH_SESSION_INVALID when under a second is left, since Max-Age=0 would clear', async () => {
    const { sessions, scripted } = setup(rotation([lockRow({ secondsLeft: 0 })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
    expect(changes(scripted.statements())).toEqual([]);
  });

  it('rolls the insert back when the delete fails, and sets no cookie', async () => {
    const { sessions, scripted } = setup(
      rotation([lockRow(), lockRow({ id: OTHER_SESSION })], { failDelete: true }),
    );
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(
      scripted.statements().map((s) => (isInsert(s) ? 'insert' : isDelete(s) ? 'delete' : 'other')),
    ).toEqual(['other', 'insert', 'delete']);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    expect(scripted.events.some((e) => e.kind === 'commit')).toBe(false);
  });

  it('maps a database failure to AUTH_UNAVAILABLE', async () => {
    const { sessions } = setup(() => {
      throw new Error('down');
    });
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('sessions_revoked log', () => {
  it('signOutOtherSessions logs scope others, the count and the public user id only', async () => {
    const { sessions, lines } = setup(rotation([lockRow(), lockRow({ id: OTHER_SESSION })]));
    const result = await sessions.signOutOtherSessions(sessionInfo(), browser());
    if (!result.ok) throw result.error;
    expect(lines).toEqual([
      {
        event: 'auth.sessions_revoked',
        fields: { scope: 'others', revoked: 1, userId: toPublicId('usr', USER) },
      },
    ]);
    const text = JSON.stringify(lines);
    for (const c of result.value.setCookies) expect(text).not.toContain(c.value);
    expect(text).not.toContain(tokenFor());
    expect(text).not.toContain(NEW_SECRET.toString('hex'));
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('person@example.com');
    expect(text).not.toContain('Mozilla');
  });

  it('signOutEverywhere logs scope all and the count', async () => {
    const { sessions, lines } = setup(() => [{ id: SESSION }, { id: OTHER_SESSION }]);
    await expect(sessions.signOutEverywhere(sessionInfo())).resolves.toBe(2);
    expect(lines).toEqual([
      {
        event: 'auth.sessions_revoked',
        fields: { scope: 'all', revoked: 2, userId: toPublicId('usr', USER) },
      },
    ]);
  });

  it('a refused or failed call logs nothing', async () => {
    const stale = setup(rotation([lockRow({ recent: false })]));
    await stale.sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(stale.lines).toEqual([]);
    const failed = setup(rotation([lockRow()], { failDelete: true }));
    await failed.sessions.signOutOtherSessions(sessionInfo(), browser());
    expect(failed.lines).toEqual([]);
  });

  it('a throwing logger does not fail a committed rotation', async () => {
    const { sessions } = setup(rotation([lockRow()]), {
      logger: {
        warn: () => undefined,
        info: () => {
          throw new Error('sink down');
        },
      },
    });
    await expect(sessions.signOutOtherSessions(sessionInfo(), browser())).resolves.toMatchObject({
      ok: true,
    });
  });
});

// Another tab may still send the old cookie after a rotation. If a failed resolve cleared the
// cookie, that response would erase the new one, so the guard calls hand back no cookies.
describe('a failed resolve never clears the session cookie', () => {
  const cases: readonly [string, string | undefined, Responder][] = [
    ['deleted', tokenFor(), sessionResponder([])],
    ['expired', tokenFor(), sessionResponder([sessionRow({ live: false })])],
    ['malformed', 'not-a-token', sessionResponder([sessionRow()])],
    ['missing', undefined, sessionResponder([sessionRow()])],
  ];

  it.each(cases)(
    '%s cookie: resolve is null and resolveAccess is a bare signed_out',
    async (_, cookie, respond) => {
      const { sessions, scripted } = setup(respond);
      await expect(sessions.resolve(cookie)).resolves.toBeNull();
      await expect(sessions.resolveSession(cookie)).resolves.toBeNull();
      const access = await sessions.resolveAccess(cookie, 'acme');
      expect(access).toStrictEqual({ kind: 'signed_out' });
      expect(Object.keys(access)).toEqual(['kind']);
      expect(changes(scripted.statements())).toEqual([]);
    },
  );
});
