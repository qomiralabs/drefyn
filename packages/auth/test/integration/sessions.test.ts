import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { CookieSpec, SessionInfo } from '../../src/index.ts';
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
});
