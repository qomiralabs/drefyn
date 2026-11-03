import { newId } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  createCliLinks,
  createOperatorSessions,
  formatCliLinkToken,
  parseAuthConfig,
  sha256,
  type AuthMetrics,
  type Organizations,
  type Sessions,
} from '../src/index.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { validEnv } from './support.ts';

const config = parseAuthConfig(validEnv());
const closed = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: 'closed' });
const USER = newId('usr');
const SECRET = new Uint8Array(32).fill(3);
const browser = { ip: '203.0.113.7', userAgent: 'Test/1.0', cookies: new Map<string, string>() };
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

// Answers by statement shape, so each case only says what the database holds.
function responder(rows: { user?: string | null; link?: string | null }) {
  return (s: Statement) => {
    if (s.sql.startsWith('select "id" from "users"')) {
      return rows.user === null || rows.user === undefined ? [] : [{ id: rows.user }];
    }
    if (s.sql.startsWith('insert into "users"')) return [{ id: USER }];
    if (s.sql.startsWith('update "cli_sign_in_links"')) {
      return rows.link === null || rows.link === undefined ? [] : [{ user_id: rows.link }];
    }
    if (s.sql.startsWith('delete from "sessions"'))
      return [{ id: newId('ses') }, { id: newId('ses') }];
    return [];
  };
}

function links(
  rows: Parameters<typeof responder>[0],
  extra: { organizations?: Organizations; sessions?: Sessions; cfg?: typeof config } = {},
) {
  const scripted = scriptedStore(responder(rows));
  const log = logger();
  const startSession = vi.fn(() =>
    Promise.resolve({
      session: {
        sessionId: newId('ses'),
        userId: USER,
        email: 'a@example.com',
        authenticatedAt: new Date(),
        expiresAt: new Date(),
        method: 'cli_link' as const,
      },
      setCookies: [],
    }),
  );
  const subject = createCliLinks(extra.cfg ?? config, {
    db: {} as never,
    authDb: {} as never,
    logger: log,
    initialTier: 'self_hosted',
    store: scripted.store,
    limiter: { reserve: () => Promise.resolve() },
    random: () => SECRET,
    sessions: extra.sessions ?? ({ startSession } as unknown as Sessions),
    ...(extra.organizations === undefined ? {} : { organizations: extra.organizations }),
  });
  return { subject, scripted, log, startSession };
}

describe('issuing a CLI link', () => {
  it('for a known address deletes unused links, stores the hash and prints from the origin', async () => {
    const { subject, scripted, log } = links({ user: USER });
    const result = await subject.issue({ email: 'A@Example.com' });
    expect(result).toEqual({
      ok: true,
      value: {
        link: `https://app.drefyn.test/sign-in/cli#${formatCliLinkToken(SECRET)}`,
        userId: USER,
        organizationId: null,
      },
    });
    const writes = scripted.writes();
    expect(writes.map((w) => w.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'delete from "cli_sign_in_links"',
      'insert into "cli_sign_in_links"',
    ]);
    expect(writes[0]?.sql).toContain('"consumed_at" is null');
    expect(writes[1]?.parameters).toContainEqual(sha256(SECRET));
    expect(writes[1]?.sql).toContain("now() + interval '15 minutes'");
    expect(JSON.stringify(writes)).not.toContain(formatCliLinkToken(SECRET));
    expect(log.info).toHaveBeenCalledWith('auth.cli_link_created', expect.any(Object));
  });

  it('makes the person when the address is new and sign up is not closed', async () => {
    const { subject, scripted } = links({ user: null });
    expect((await subject.issue({ email: 'new@example.com' })).ok).toBe(true);
    expect(scripted.writes()[0]?.sql).toMatch(/^insert into "users"/);
  });

  it('refuses a new address when sign up is closed, writing nothing', async () => {
    const { subject, scripted } = links({ user: null }, { cfg: closed });
    const result = await subject.issue({ email: 'new@example.com' });
    expect(!result.ok && result.error.code).toBe('AUTH_SIGNUP_CLOSED');
    expect(scripted.writes()).toEqual([]);
  });

  it('refuses bad input before any statement', async () => {
    const { subject, scripted } = links({ user: USER });
    for (const input of [
      { email: 'nope' },
      { email: 'a@example.com', organizationName: '   ' },
      { email: 'a@example.com', organizationName: '!!!' },
    ]) {
      expect((await subject.issue(input)).ok).toBe(false);
    }
    expect(scripted.statements()).toEqual([]);
  });

  it('creates the organization through createOrganizationFor with the derived slug', async () => {
    const organizationId = newId('org');
    const createOrganizationFor = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: { organizationId, slug: 'acme-docs' } }),
    );
    const organizations = { createOrganizationFor } as unknown as Organizations;
    const { subject } = links({ user: USER }, { organizations });
    const result = await subject.issue({ email: 'a@example.com', organizationName: 'Acme Docs' });
    expect(result.ok && result.value.organizationId).toBe(organizationId);
    expect(createOrganizationFor).toHaveBeenCalledWith(USER, {
      name: 'Acme Docs',
      slug: 'acme-docs',
    });
  });

  it('prints no link when the organization is refused', async () => {
    const organizations = {
      createOrganizationFor: () =>
        Promise.resolve({ ok: false as const, error: new AuthError('AUTH_SLUG_TAKEN') }),
    } as unknown as Organizations;
    const { subject, scripted } = links({ user: USER }, { organizations });
    const result = await subject.issue({ email: 'a@example.com', organizationName: 'Acme' });
    expect(!result.ok && result.error.code).toBe('AUTH_SLUG_TAKEN');
    expect(scripted.writes()).toEqual([]);
  });

  it('answers AUTH_UNAVAILABLE when the database fails', async () => {
    const { subject, scripted } = links({ user: USER });
    scripted.respondWith(() => {
      throw new Error('connection reset');
    });
    const result = await subject.issue({ email: 'a@example.com' });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('redeeming a CLI link', () => {
  it('consumes the row in one update keyed by the hash, then starts a cli_link session', async () => {
    const { subject, scripted, startSession, log } = links({ link: USER });
    const result = await subject.redeem(browser, formatCliLinkToken(SECRET));
    expect(result.ok).toBe(true);
    const [update] = scripted.statements();
    expect(update?.sql).toMatch(/^update "cli_sign_in_links" set "consumed_at" = now\(\)/);
    expect(update?.sql).toContain('"consumed_at" is null');
    expect(update?.sql).toContain('"expires_at" > now()');
    expect(update?.parameters).toEqual([sha256(SECRET)]);
    expect(startSession).toHaveBeenCalledWith(browser, {
      userId: idOf('usr', USER),
      method: 'cli_link',
    });
    expect(log.info).toHaveBeenCalledWith('auth.cli_link_redeemed', expect.any(Object));
  });

  it('refuses a secret that matches no live row, and starts nothing', async () => {
    const { subject, startSession, log } = links({ link: null });
    const result = await subject.redeem(browser, formatCliLinkToken(SECRET));
    expect(!result.ok && result.error.code).toBe('AUTH_CLI_LINK_INVALID');
    expect(startSession).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('auth.cli_link_refused', { reason: 'no_match' });
  });

  it('answers AUTH_UNAVAILABLE when the update or the session fails', async () => {
    const broken = links({ link: USER });
    broken.scripted.respondWith(() => {
      throw new Error('down');
    });
    const a = await broken.subject.redeem(browser, formatCliLinkToken(SECRET));
    expect(!a.ok && a.error.code).toBe('AUTH_UNAVAILABLE');
    const sessions = {
      startSession: () => Promise.reject(new Error('insert failed')),
    } as unknown as Sessions;
    const b = await links({ link: USER }, { sessions }).subject.redeem(
      browser,
      formatCliLinkToken(SECRET),
    );
    expect(!b.ok && b.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('refuses an address the limiter cannot key, before anything else', async () => {
    const { subject, scripted } = links({ link: USER });
    const result = await subject.redeem(
      { ...browser, ip: 'not an ip' },
      formatCliLinkToken(SECRET),
    );
    expect(result.ok).toBe(false);
    expect(scripted.statements()).toEqual([]);
  });
});

describe('operator session revoke', () => {
  function operator(rows: { user?: string | null }, pages: string[][] = []) {
    let page = 0;
    const scripted = scriptedStore((s) => {
      if (s.sql.startsWith('select "id" from "users" where "email_normalized"')) {
        return rows.user === null || rows.user === undefined ? [] : [{ id: rows.user }];
      }
      if (s.sql.startsWith('select "id" from "users"')) {
        const ids = pages[page] ?? [];
        page += 1;
        return ids.map((id) => ({ id }));
      }
      if (s.sql.startsWith('delete from "sessions"')) return [{ id: newId('ses') }];
      return [];
    });
    const subject = createOperatorSessions({
      db: {} as never,
      authDb: {} as never,
      logger: logger(),
      store: scripted.store,
    });
    return { subject, scripted };
  }

  it('ends a person sessions and forgets their devices under their own user context', async () => {
    const { subject, scripted } = operator({ user: USER });
    expect(await subject.revokeForEmail('A@example.com')).toEqual({ ok: true, value: 1 });
    const begins = scripted.events.filter((e) => e.kind === 'begin');
    expect(begins).toEqual([
      { kind: 'begin', scope: 'auth' },
      { kind: 'begin', scope: 'user', userId: idOf('usr', USER) },
    ]);
    expect(scripted.writes().map((w) => w.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'delete from "sessions"',
      'delete from "known_devices"',
    ]);
  });

  it('refuses a bad address and an unknown one', async () => {
    const bad = await operator({ user: USER }).subject.revokeForEmail('nope');
    expect(!bad.ok && bad.error.code).toBe('AUTH_INPUT_INVALID');
    const unknown = await operator({ user: null }).subject.revokeForEmail('a@example.com');
    expect(!unknown.ok && unknown.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('pages through every person for --all', async () => {
    const full = Array.from({ length: 500 }, () => newId('usr'));
    const { subject, scripted } = operator({}, [full, [newId('usr')]]);
    expect(await subject.revokeAll()).toBe(501);
    const reads = scripted.statements().filter((s) => s.sql.startsWith('select "id" from "users"'));
    expect(reads).toHaveLength(2);
    expect(reads[1]?.sql).toContain('where "id" >');
    expect(reads[1]?.parameters[0]).toBe(full[499]);
  });

  it('answers AUTH_UNAVAILABLE when the database fails', async () => {
    const { subject, scripted } = operator({ user: USER });
    scripted.respondWith(() => {
      throw new Error('down');
    });
    const one = await subject.revokeForEmail('a@example.com');
    expect(!one.ok && one.error.code).toBe('AUTH_UNAVAILABLE');
    await expect(subject.revokeAll()).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });
});

describe('the redemption counter and refusal reasons', () => {
  function counted(
    rows: Parameters<typeof responder>[0],
    reserve: () => Promise<void> = () => Promise.resolve(),
    increment: AuthMetrics['increment'] = vi.fn(),
  ) {
    const scripted = scriptedStore(responder(rows));
    const log = logger();
    const startSession = vi.fn(() => Promise.resolve({ session: {}, setCookies: [] }));
    const subject = createCliLinks(config, {
      db: {} as never,
      authDb: {} as never,
      logger: log,
      initialTier: 'self_hosted',
      store: scripted.store,
      limiter: { reserve },
      metrics: { increment },
      sessions: { startSession } as unknown as Sessions,
    });
    return { subject, scripted, log, startSession, increment };
  }

  const token = formatCliLinkToken(SECRET);
  const refusedWith = (log: ReturnType<typeof logger>) =>
    log.info.mock.calls.filter(([event]) => event === 'auth.cli_link_refused').map(([, f]) => f);

  it('counts a redemption once as redeemed', async () => {
    const { subject, increment } = counted({ link: USER });
    expect((await subject.redeem(browser, token)).ok).toBe(true);
    expect(vi.mocked(increment).mock.calls).toEqual([['auth.cli_link', { outcome: 'redeemed' }]]);
  });

  it.each([
    ['malformed', 'drf_cl_nope', { link: USER }],
    ['no_match', token, { link: null }],
  ] as const)('counts and logs %s once', async (outcome, value, rows) => {
    const { subject, increment, log } = counted(rows);
    await subject.redeem(browser, value);
    expect(vi.mocked(increment).mock.calls).toEqual([['auth.cli_link', { outcome }]]);
    expect(refusedWith(log)).toEqual([{ reason: outcome }]);
  });

  it('counts a full bucket as rate_limited and keeps the error', async () => {
    const { subject, increment, log } = counted({ link: USER }, () =>
      Promise.reject(new AuthError('AUTH_RATE_LIMITED')),
    );
    const result = await subject.redeem(browser, token);
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
    expect(vi.mocked(increment).mock.calls).toEqual([
      ['auth.cli_link', { outcome: 'rate_limited' }],
    ]);
    expect(refusedWith(log)).toEqual([{ reason: 'rate_limited' }]);
  });

  it('reports an unkeyable address as client_address, never rate_limited', async () => {
    const reserve = vi.fn(() => Promise.resolve());
    const { subject, increment, log } = counted({ link: USER }, reserve);
    const result = await subject.redeem({ ...browser, ip: 'not an ip' }, token);
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(reserve).not.toHaveBeenCalled();
    expect(vi.mocked(increment).mock.calls).toEqual([
      ['auth.cli_link', { outcome: 'client_address' }],
    ]);
    expect(refusedWith(log)).toEqual([{ reason: 'client_address' }]);
  });

  it.each([
    ['an AuthError', new AuthError('AUTH_UNAVAILABLE')],
    ['any other failure', new Error('connection reset')],
    ['an unexpected AuthError', new AuthError('AUTH_FORBIDDEN')],
  ])('reports a limiter outage from %s as unavailable', async (_name, failure) => {
    const { subject, increment, log, scripted } = counted({ link: USER }, () =>
      Promise.reject(failure),
    );
    const result = await subject.redeem(browser, token);
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(vi.mocked(increment).mock.calls).toEqual([
      ['auth.cli_link', { outcome: 'unavailable' }],
    ]);
    expect(refusedWith(log)).toEqual([{ reason: 'unavailable' }]);
    expect(scripted.statements()).toEqual([]);
  });

  it('counts a failed consume and a failed session as unavailable', async () => {
    const consume = counted({ link: USER });
    consume.scripted.respondWith(() => {
      throw new Error('down');
    });
    await consume.subject.redeem(browser, token);
    expect(vi.mocked(consume.increment).mock.calls).toEqual([
      ['auth.cli_link', { outcome: 'unavailable' }],
    ]);
    const session = counted({ link: USER });
    session.startSession.mockRejectedValueOnce(new Error('insert failed'));
    await session.subject.redeem(browser, token);
    expect(vi.mocked(session.increment).mock.calls).toEqual([
      ['auth.cli_link', { outcome: 'unavailable' }],
    ]);
  });

  it('a metrics sink that throws changes nothing', async () => {
    const { subject } = counted({ link: USER }, undefined, () => {
      throw new Error('sink down');
    });
    expect((await subject.redeem(browser, token)).ok).toBe(true);
    const refused = counted({ link: null }, undefined, () => {
      throw new Error('sink down');
    });
    const result = await refused.subject.redeem(browser, token);
    expect(!result.ok && result.error.code).toBe('AUTH_CLI_LINK_INVALID');
  });
});
