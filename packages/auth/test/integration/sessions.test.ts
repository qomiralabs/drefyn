import { withAuth, withUser } from '@drefyn/db';
import { toPublicId } from '@drefyn/tenancy';
import type { Transaction } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CookieSpec, SessionInfo, SessionStore } from '../../src/index.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const browser = (cookies: readonly CookieSpec[] = []) => ({
  ip: '203.0.113.9',
  userAgent: 'Integration/1.0',
  cookies: new Map(cookies.map((c) => [c.name, c.value])),
});

const cookieOf = (h: Harness, cookies: readonly CookieSpec[]) => {
  const found = cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0);
  if (found === undefined) throw new Error('no session cookie');
  return found.value;
};

const rowOf = (session: SessionInfo) =>
  h.sql(
    `select xmin::text || '|' || last_seen_at::text from app.sessions where id = '${session.sessionId}';`,
  );

async function signIn(user?: Awaited<ReturnType<Harness['user']>>) {
  const sessions = h.sessions();
  const id = user ?? (await h.user());
  const started = await sessions.startSession(browser(), { userId: id, method: 'email' });
  return {
    sessions,
    user: id,
    session: started.session,
    cookie: cookieOf(h, started.setCookies),
    started,
  };
}

describeWithStack('sessions against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and resolves a session, with times from the database', async () => {
    const { sessions, cookie, session } = await signIn();
    const resolved = await sessions.resolve(cookie);
    expect(resolved?.session.sessionId).toBe(session.sessionId);
    expect(resolved?.touchDue).toBe(false);
    const days = await h.sql(
      `select round(extract(epoch from expires_at - authenticated_at) / 86400) from app.sessions where id = '${session.sessionId}';`,
    );
    expect(days).toBe('30');
  });

  it('an app clock skewed by a day either way changes nothing', async () => {
    const { sessions, cookie, session } = await signIn();
    for (const skewDays of [1, -1, 40]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + skewDays * 86_400_000);
      await expect(sessions.resolveSession(cookie)).resolves.toMatchObject({
        sessionId: session.sessionId,
      });
      vi.useRealTimers();
    }
    // A session started under a skewed clock still gets database times.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 86_400_000);
    const skewed = await signIn();
    vi.useRealTimers();
    const gap = await h.sql(
      `select abs(extract(epoch from authenticated_at - now())) < 60 from app.sessions where id = '${skewed.session.sessionId}';`,
    );
    expect(gap).toBe('t');
  });

  it('expires on the idle limit and on the absolute limit by database time', async () => {
    const idle = await signIn();
    await h.sql(
      `update app.sessions set last_seen_at = now() - interval '7 days 1 minute' where id = '${idle.session.sessionId}';`,
    );
    await expect(idle.sessions.resolveSession(idle.cookie)).resolves.toBeNull();
    const absolute = await signIn();
    await h.sql(
      `update app.sessions set expires_at = now() - interval '1 second' where id = '${absolute.session.sessionId}';`,
    );
    await expect(absolute.sessions.resolveSession(absolute.cookie)).resolves.toBeNull();
    const nearly = await signIn();
    await h.sql(
      `update app.sessions set last_seen_at = now() - interval '6 days 23 hours' where id = '${nearly.session.sessionId}';`,
    );
    await expect(nearly.sessions.resolveSession(nearly.cookie)).resolves.not.toBeNull();
  });

  it('the guard transaction sends no write, even when a touch is due', async () => {
    const { sessions, cookie, session } = await signIn();
    await h.sql(
      `update app.sessions set last_seen_at = now() - interval '2 hours' where id = '${session.sessionId}';`,
    );
    const before = await rowOf(session);
    const first = await sessions.resolve(cookie);
    const second = await sessions.resolve(cookie);
    expect(first?.touchDue).toBe(true);
    expect(second?.touchDue).toBe(true);
    // xmin moves on any update of the row, so an unchanged xmin means nothing was written.
    expect(await rowOf(session)).toBe(before);
  });

  it('writes last_seen_at at most once an hour: two touches inside an hour write once', async () => {
    const { sessions, cookie, session, user } = await signIn();
    await h.sql(
      `update app.sessions set last_seen_at = now() - interval '2 hours' where id = '${session.sessionId}';`,
    );
    const before = await rowOf(session);
    await sessions.touchSession({ userId: user, sessionId: session.sessionId });
    const afterFirst = await rowOf(session);
    expect(afterFirst).not.toBe(before);
    await sessions.touchSession({ userId: user, sessionId: session.sessionId });
    expect(await rowOf(session)).toBe(afterFirst);
    expect((await sessions.resolve(cookie))?.touchDue).toBe(false);
    // Two resolves inside the hour write nothing either.
    await sessions.resolve(cookie);
    await sessions.resolve(cookie);
    expect(await rowOf(session)).toBe(afterFirst);
  });

  it('a touch for another user writes nothing, and a touch after revoke writes nothing', async () => {
    const a = await signIn();
    const b = await signIn();
    await h.sql(
      `update app.sessions set last_seen_at = now() - interval '2 hours' where id = '${a.session.sessionId}';`,
    );
    const before = await rowOf(a.session);
    await a.sessions.touchSession({ userId: b.user, sessionId: a.session.sessionId });
    expect(await rowOf(a.session)).toBe(before);
    await a.sessions.signOut(a.session);
    const logged = h.logs.length;
    await a.sessions.touchSession({ userId: a.user, sessionId: a.session.sessionId });
    expect(
      await h.sql(`select count(*) from app.sessions where id = '${a.session.sessionId}';`),
    ).toBe('0');
    expect(h.logs.length).toBe(logged);
  });

  it('sign out everywhere takes effect on the next resolve for every other session', async () => {
    const first = await signIn();
    const others = await Promise.all(
      [1, 2, 3].map(() =>
        first.sessions.startSession(browser(), { userId: first.user, method: 'password' }),
      ),
    );
    const bystander = await signIn();
    for (const other of others) {
      await expect(
        first.sessions.resolveSession(cookieOf(h, other.setCookies)),
      ).resolves.not.toBeNull();
    }
    await expect(first.sessions.signOutEverywhere(first.session)).resolves.toBe(4);
    for (const other of others) {
      await expect(
        first.sessions.resolveSession(cookieOf(h, other.setCookies)),
      ).resolves.toBeNull();
    }
    await expect(first.sessions.resolveSession(first.cookie)).resolves.toBeNull();
    await expect(bystander.sessions.resolveSession(bystander.cookie)).resolves.not.toBeNull();
  });

  it('lists live sessions and revokes one, which then stops resolving', async () => {
    const first = await signIn();
    const second = await first.sessions.startSession(browser(), {
      userId: first.user,
      method: 'google',
    });
    const expired = await first.sessions.startSession(browser(), {
      userId: first.user,
      method: 'email',
    });
    await h.sql(
      `update app.sessions set expires_at = now() - interval '1 second' where id = '${expired.session.sessionId}';`,
    );
    const list = await first.sessions.listSessions(first.session);
    expect(list.map((s) => s.sessionId).sort()).toEqual(
      [first.session.sessionId, second.session.sessionId].sort(),
    );
    expect(list.find((s) => s.current)?.sessionId).toBe(first.session.sessionId);
    expect(list.every((s) => s.userAgent === 'Integration/1.0')).toBe(true);
    await expect(
      first.sessions.revokeSession(first.session, second.session.sessionId),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(first.sessions.resolveSession(cookieOf(h, second.setCookies))).resolves.toBeNull();
    const again = await first.sessions.revokeSession(first.session, second.session.sessionId);
    expect(!again.ok && again.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('cannot revoke a session of another user', async () => {
    const a = await signIn();
    const b = await signIn();
    const result = await a.sessions.revokeSession(a.session, b.session.sessionId);
    expect(!result.ok && result.error.code).toBe('AUTH_NOT_FOUND');
    await expect(b.sessions.resolveSession(b.cookie)).resolves.not.toBeNull();
  });

  it('a new sign in as a different user in the same browser deletes the previous row', async () => {
    const a = await signIn();
    const other = await h.user();
    const next = await a.sessions.startSession(
      browser([{ name: h.config.cookies.session, value: a.cookie, maxAgeSeconds: 1 }]),
      { userId: other, method: 'email' },
    );
    expect(
      await h.sql(`select count(*) from app.sessions where id = '${a.session.sessionId}';`),
    ).toBe('0');
    await expect(a.sessions.resolveSession(cookieOf(h, next.setCookies))).resolves.toMatchObject({
      userId: other,
    });
  });

  it('a forged old cookie with the wrong secret deletes nothing', async () => {
    const a = await signIn();
    const forged = `${a.cookie.slice(0, -1)}${a.cookie.endsWith('0') ? '1' : '0'}`;
    await a.sessions.startSession(
      browser([{ name: h.config.cookies.session, value: forged, maxAgeSeconds: 1 }]),
      { userId: await h.user(), method: 'email' },
    );
    expect(
      await h.sql(`select count(*) from app.sessions where id = '${a.session.sessionId}';`),
    ).toBe('1');
  });

  it('deleting a user deletes their sessions', async () => {
    const a = await signIn();
    await a.sessions.startSession(browser(), { userId: a.user, method: 'github' });
    expect(await h.sql(`select count(*) from app.sessions where user_id = '${a.user}';`)).toBe('2');
    await h.sql(`delete from app.users where id = '${a.user}';`);
    expect(await h.sql(`select count(*) from app.sessions where user_id = '${a.user}';`)).toBe('0');
    await expect(a.sessions.resolveSession(a.cookie)).resolves.toBeNull();
  });

  describe('signOutOtherSessions', () => {
    // Every column of every row of the user, so "unchanged" means byte for byte.
    const rowsOf = (user: string) =>
      h.sql(
        `select coalesce(string_agg(s::text, '|' order by id), '') from app.sessions s where user_id = '${user}';`,
      );

    const valueOf = (cookies: readonly CookieSpec[]) => cookieOf(h, cookies);

    async function withOthers(count: number) {
      const first = await signIn();
      await h.sql(
        `update app.sessions set method = 'password', step_up_method = 'email' where id = '${first.session.sessionId}';`,
      );
      const others = [];
      for (let i = 0; i < count; i += 1) {
        others.push(
          await first.sessions.startSession(browser(), { userId: first.user, method: 'google' }),
        );
      }
      const session = await first.sessions.resolveSession(first.cookie);
      if (session === null) throw new Error('first session did not resolve');
      return { ...first, session, others };
    }

    it('reissues this browser on a new row that copies the old one, and every old cookie stops working', async () => {
      const a = await withOthers(2);
      const bystander = await signIn();
      const old = await h.sql(
        `select method || '|' || step_up_method || '|' || authenticated_at::text || '|' || user_agent || '|' || expires_at::text from app.sessions where id = '${a.session.sessionId}';`,
      );
      const result = await a.sessions.signOutOtherSessions(a.session, {
        ...browser(),
        userAgent: 'SomethingElse/2.0',
      });
      if (!result.ok) throw result.error;
      expect(result.value.revoked).toBe(2);
      const next = valueOf(result.value.setCookies);
      const resolved = await a.sessions.resolveSession(next);
      expect(resolved?.userId).toBe(a.user);
      expect(resolved?.sessionId).not.toBe(a.session.sessionId);
      expect(next).not.toBe(a.cookie);
      expect(await h.sql(`select count(*) from app.sessions where user_id = '${a.user}';`)).toBe(
        '1',
      );
      const now = await h.sql(
        `select method || '|' || step_up_method || '|' || authenticated_at::text || '|' || user_agent || '|' || expires_at::text from app.sessions where user_id = '${a.user}';`,
      );
      expect(now).toBe(old);
      expect(now).toContain('Integration/1.0');
      // The old cookie, the same value copied to another machine and resolved by another
      // instance, and the other browsers' cookies.
      await expect(a.sessions.resolveSession(a.cookie)).resolves.toBeNull();
      await expect(h.sessions().resolveSession(a.cookie)).resolves.toBeNull();
      for (const other of a.others) {
        await expect(a.sessions.resolveSession(valueOf(other.setCookies))).resolves.toBeNull();
      }
      await expect(bystander.sessions.resolveSession(bystander.cookie)).resolves.not.toBeNull();
    });

    it('sets Max-Age to the seconds left on the old row, within a second', async () => {
      const a = await withOthers(0);
      await h.sql(
        `update app.sessions set expires_at = now() + interval '3 days 5 hours' where id = '${a.session.sessionId}';`,
      );
      const result = await a.sessions.signOutOtherSessions(a.session, browser());
      if (!result.ok) throw result.error;
      const cookie = result.value.setCookies.find((c) => c.name === h.config.cookies.session);
      const left = Number(
        await h.sql(
          `select extract(epoch from expires_at - now())::bigint from app.sessions where user_id = '${a.user}';`,
        ),
      );
      expect(Math.abs((cookie?.maxAgeSeconds ?? 0) - left)).toBeLessThanOrEqual(1);
      expect(cookie?.maxAgeSeconds).toBeLessThan(30 * 86_400);
    });

    it('refuses a sign in older than 15 minutes and changes no row', async () => {
      const a = await withOthers(2);
      await h.sql(
        `update app.sessions set authenticated_at = now() - interval '16 minutes' where id = '${a.session.sessionId}';`,
      );
      const before = await rowsOf(a.user);
      const result = await a.sessions.signOutOtherSessions(a.session, browser());
      expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
      expect(await rowsOf(a.user)).toBe(before);
    });

    it('refuses a current row revoked from another tab and changes no row', async () => {
      const a = await withOthers(2);
      const tab = a.others[0];
      if (tab === undefined) throw new Error('no other session');
      await a.sessions.revokeSession(tab.session, a.session.sessionId);
      const before = await rowsOf(a.user);
      const result = await a.sessions.signOutOtherSessions(a.session, browser());
      expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
      expect(await rowsOf(a.user)).toBe(before);
    });

    it('two parallel calls from two cookies of one user leave exactly one live session', async () => {
      const a = await withOthers(1);
      const other = a.others[0];
      if (other === undefined) throw new Error('no other session');
      const b = await a.sessions.resolveSession(valueOf(other.setCookies));
      if (b === null) throw new Error('second session did not resolve');
      const results = await Promise.all([
        a.sessions.signOutOtherSessions(a.session, browser()),
        h.sessions().signOutOtherSessions(b, browser()),
      ]);
      const won = results.filter((r) => r.ok);
      const lost = results.filter((r) => !r.ok);
      expect(won).toHaveLength(1);
      expect(lost.map((r) => r.error.code)).toEqual(['AUTH_SESSION_INVALID']);
      expect(await h.sql(`select count(*) from app.sessions where user_id = '${a.user}';`)).toBe(
        '1',
      );
      const [winner] = won;
      if (winner === undefined) throw new Error('no winner');
      await expect(
        a.sessions.resolveSession(valueOf(winner.value.setCookies)),
      ).resolves.toMatchObject({ userId: a.user });
    });

    it('a delete that fails after the insert leaves every original row and no new one', async () => {
      const a = await withOthers(2);
      const before = await rowsOf(a.user);
      // Kysely keeps its state in private fields, so methods run bound to the real object.
      const failingDelete = <S>(tx: Transaction<S>): Transaction<S> =>
        new Proxy(tx, {
          get(target, key) {
            if (key === 'deleteFrom') {
              return () => {
                throw new Error('injected delete failure');
              };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function'
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      const store: SessionStore = {
        user: (userId, work) => withUser(h.db, { userId }, (tx) => work(failingDelete(tx))),
        auth: (work) => withAuth(h.authDb, work),
      };
      const sessions = h.sessions({ store });
      const result = await sessions.signOutOtherSessions(a.session, browser());
      expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
      expect(await rowsOf(a.user)).toBe(before);
      await expect(a.sessions.resolveSession(a.cookie)).resolves.not.toBeNull();
    });

    it('logs scope and count for both calls, and no cookie value, secret or address', async () => {
      const a = await withOthers(1);
      const mark = h.logs.length;
      const result = await a.sessions.signOutOtherSessions(a.session, browser());
      if (!result.ok) throw result.error;
      const b = await signIn();
      await b.sessions.signOutEverywhere(b.session);
      const lines = h.logs.slice(mark);
      expect(lines.filter((l) => l.event === 'auth.sessions_revoked')).toEqual([
        {
          level: 'info',
          event: 'auth.sessions_revoked',
          fields: { scope: 'others', revoked: 1, userId: toPublicId('usr', a.user) },
        },
        {
          level: 'info',
          event: 'auth.sessions_revoked',
          fields: { scope: 'all', revoked: 1, userId: toPublicId('usr', b.user) },
        },
      ]);
      const text = JSON.stringify(lines);
      expect(text).not.toContain(a.cookie);
      expect(text).not.toContain(valueOf(result.value.setCookies));
      expect(text).not.toContain(b.cookie);
      expect(text).not.toContain('203.0.113.9');
      expect(text).not.toContain('@example.com');
    });
  });
});
