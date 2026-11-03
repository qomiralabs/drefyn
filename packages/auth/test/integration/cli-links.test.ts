import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { runAuthCommand } from '../../src/command.ts';
import {
  createCliLinks,
  createSessions,
  formatCliLinkToken,
  parseAuthConfig,
  parseCliLinkToken,
  sha256,
  type AuthConfig,
  type AuthLogger,
  type AuthMailer,
  type Env,
} from '../../src/index.ts';
import { validEnv } from '../support.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import { migrateCli, run, urlFor } from './support/stack.ts';

const fresh = harness();
let h: Harness;
let env: Env;
let config: AuthConfig;

const LINK = /^https:\/\/app\.drefyn\.test\/sign-in\/cli#(drf_cl_[0-9a-hjkmnp-tv-z]{52})\n$/;

function sink() {
  let text = '';
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

async function drefyn(argv: readonly string[], extra: Env = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runAuthCommand({ argv, env: { ...env, ...extra }, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function link(email: string, extra: readonly string[] = [], more: Env = {}) {
  const result = await drefyn(['auth', 'link', '--email', email, ...extra], more);
  expect(result.code, result.stderr).toBe(0);
  const token = LINK.exec(result.stdout)?.[1];
  if (token === undefined) throw new Error(`no link printed: ${result.stdout}`);
  return { token, ...result };
}

const logs: { event: string; fields: unknown }[] = [];
const logger: AuthLogger = {
  info: (event, fields) => logs.push({ event, fields }),
  warn: (event, fields) => logs.push({ event, fields }),
};

// Any call fails the test: no CLI path may send mail.
const throwingMailer = new Proxy({} as AuthMailer, {
  get() {
    throw new Error('the mailer was used');
  },
});

const browser = (ip = '203.0.113.20') => ({
  ip,
  userAgent: 'Integration/1.0',
  cookies: new Map<string, string>(),
});

function links() {
  return createCliLinks(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    initialTier: 'self_hosted',
    sessions: createSessions(config, {
      db: h.db,
      authDb: h.authDb,
      logger,
      mailer: throwingMailer,
    }),
  });
}

const count = async (where: string) => (await h.sql(`select count(*) from ${where};`)).trim();
const userOf = async (email: string) =>
  (await h.sql(`select id from app.users where email_normalized = '${email}';`)).trim();

describeWithStack('drefyn auth link and its redemption', () => {
  beforeAll(async () => {
    h = await fresh();
    env = {
      ...validEnv(randomBytes(32).toString('base64url')),
      DREFYN_DATABASE_URL: urlFor('app', h.name),
      DREFYN_AUTH_DATABASE_URL: urlFor('auth', h.name),
      DREFYN_DATABASE_SSL: 'disable',
    };
    config = parseAuthConfig(env);
  });

  it('prints one link on stdout and the rule on stderr, and the link signs in once', async () => {
    const email = `first-${randomBytes(3).toString('hex')}@example.com`;
    const { token, stderr } = await link(email);
    expect(stderr.endsWith('Valid once, for 15 minutes.\n')).toBe(true);
    expect(stderr).toContain('"event":"auth.cli_link_created"');
    expect(stderr).not.toContain(email);
    expect(stderr).not.toContain(token.slice(7));
    const first = await links().redeem(browser(), token);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.session.method).toBe('cli_link');
    const stored = await h.sql(
      `select method from app.sessions where id = '${first.value.session.sessionId}';`,
    );
    expect(stored.trim()).toBe('cli_link');
    const again = await links().redeem(browser(), token);
    expect(!again.ok && again.error.code).toBe('AUTH_CLI_LINK_INVALID');
  });

  it('runs through the drefyn binary with no SMTP configured', async () => {
    const email = `bin-${randomBytes(3).toString('hex')}@example.com`;
    const result = await run(process.execPath, [migrateCli, 'auth', 'link', '--email', email], {
      env: { PATH: process.env['PATH'], ...env },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(LINK);
    expect(Object.keys(env).some((key) => key.includes('SMTP'))).toBe(false);
  });

  it('stores only a hash that expires 15 minutes out by database time', async () => {
    const email = `hash-${randomBytes(3).toString('hex')}@example.com`;
    const { token } = await link(email);
    const user = await userOf(email);
    const secret = parseCliLinkToken(token);
    if (secret === null) throw new Error('printed token does not parse');
    const row = await h.sql(
      `select encode(secret_hash, 'hex') || '|' || round(extract(epoch from expires_at - created_at))
         from app.cli_sign_in_links where user_id = '${user}';`,
    );
    // The hash of the decoded 32 bytes; the printed text itself is stored nowhere.
    expect(row.trim()).toBe(`${sha256(secret).toString('hex')}|900`);
  });

  it('refuses an expired link using database time', async () => {
    const email = `old-${randomBytes(3).toString('hex')}@example.com`;
    const { token } = await link(email);
    await h.sql(
      `update app.cli_sign_in_links set expires_at = now() - interval '1 second' where user_id = '${await userOf(email)}';`,
    );
    const result = await links().redeem(browser(), token);
    expect(!result.ok && result.error.code).toBe('AUTH_CLI_LINK_INVALID');
  });

  it('a wrong secret writes nothing', async () => {
    const email = `wrong-${randomBytes(3).toString('hex')}@example.com`;
    await link(email);
    const user = await userOf(email);
    const before = await h.sql(
      `select xmin::text || coalesce(consumed_at::text, '-') from app.cli_sign_in_links where user_id = '${user}';`,
    );
    const sessionsBefore = await count('app.sessions');
    const result = await links().redeem(browser(), formatCliLinkToken(randomBytes(32)));
    expect(!result.ok && result.error.code).toBe('AUTH_CLI_LINK_INVALID');
    expect(
      await h.sql(
        `select xmin::text || coalesce(consumed_at::text, '-') from app.cli_sign_in_links where user_id = '${user}';`,
      ),
    ).toBe(before);
    expect(await count('app.sessions')).toBe(sessionsBefore);
  });

  it('50 parallel redemptions of one link make exactly one session', async () => {
    const email = `race-${randomBytes(3).toString('hex')}@example.com`;
    const { token } = await link(email);
    const user = await userOf(email);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => links().redeem(browser(`198.51.100.${i + 1}`), token)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const codes = results.flatMap((r) => (r.ok ? [] : [r.error.code]));
    expect(codes).toEqual(Array<string>(49).fill('AUTH_CLI_LINK_INVALID'));
    expect(await count(`app.sessions where user_id = '${user}'`)).toBe('1');
  });

  it('a new link deletes the older unused one', async () => {
    const email = `twice-${randomBytes(3).toString('hex')}@example.com`;
    const older = await link(email);
    const newer = await link(email);
    expect(await count(`app.cli_sign_in_links where user_id = '${await userOf(email)}'`)).toBe('1');
    const stale = await links().redeem(browser(), older.token);
    expect(!stale.ok && stale.error.code).toBe('AUTH_CLI_LINK_INVALID');
    expect((await links().redeem(browser(), newer.token)).ok).toBe(true);
  });

  it('follows the sign up mode: closed refuses a new address with exit 2, an existing one works', async () => {
    const known = `known-${randomBytes(3).toString('hex')}@example.com`;
    await link(known);
    const closed = { DREFYN_AUTH_SIGNUP: 'closed' };
    const refused = await drefyn(
      ['auth', 'link', '--email', `new-${randomBytes(3).toString('hex')}@example.com`],
      closed,
    );
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('AUTH_SIGNUP_CLOSED');
    await link(known, [], closed);
  });

  it('creates the first organization with the person as owner, through the insert rules', async () => {
    const email = `owner-${randomBytes(3).toString('hex')}@example.com`;
    const name = `Acme ${randomBytes(2).toString('hex')}`;
    const { token } = await link(email, ['--create-organization', name]);
    const user = await userOf(email);
    const row = await h.sql(
      `select o.name || '|' || s.slug || '|' || m.role || '|' || o.plan_tier
         from app.memberships m
         join app.organizations o on o.organization_id = m.organization_id
         join app.organization_slugs s on s.organization_id = m.organization_id
        where m.user_id = '${user}';`,
    );
    expect(row.trim()).toBe(`${name}|${name.toLowerCase().replace(' ', '-')}|owner|self_hosted`);
    expect((await links().redeem(browser(), token)).ok).toBe(true);
    // The same name again holds the same slug, so it is refused and no link is printed.
    const taken = await drefyn([
      'auth',
      'link',
      '--email',
      `other-${randomBytes(3).toString('hex')}@example.com`,
      '--create-organization',
      name,
    ]);
    expect(taken.code).toBe(2);
    expect(taken.stdout).toBe('');
    expect(taken.stderr).toContain('AUTH_SLUG_TAKEN');
  });

  it('exits 4 when the auth role is not the one the URL logs in as', async () => {
    const result = await drefyn(['auth', 'link', '--email', 'role@example.com'], {
      DREFYN_AUTH_DATABASE_URL: urlFor('app', h.name),
    });
    expect(result.code).toBe(4);
    expect(result.stdout).toBe('');
  });

  it('puts no secret, link or address in any log', async () => {
    const email = `quiet-${randomBytes(3).toString('hex')}@example.com`;
    const { token } = await link(email);
    await links().redeem(browser(), token);
    await links().redeem(browser(), token);
    await links().redeem(browser(), 'drf_cl_nonsense');
    const text = JSON.stringify(logs);
    expect(text).not.toContain(token.slice(7));
    expect(text).not.toContain('drf_cl_');
    expect(text).not.toContain(email);
    expect(logs.map((l) => l.event)).toEqual(
      expect.arrayContaining(['auth.cli_link_redeemed', 'auth.cli_link_refused']),
    );
  });
});

describeWithStack('drefyn auth revoke-sessions', () => {
  let r: Harness;
  let revokeEnv: Env;

  beforeAll(async () => {
    r = await fresh();
    revokeEnv = {
      ...validEnv(randomBytes(32).toString('base64url')),
      DREFYN_DATABASE_URL: urlFor('app', r.name),
      DREFYN_AUTH_DATABASE_URL: urlFor('auth', r.name),
      DREFYN_DATABASE_SSL: 'disable',
    };
  });

  async function revoke(argv: readonly string[]) {
    const stdout = sink();
    const stderr = sink();
    const code = await runAuthCommand({
      argv: ['auth', 'revoke-sessions', ...argv],
      env: revokeEnv,
      stdout,
      stderr,
    });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  async function signedIn(email: string, times: number) {
    const user = await r.user(email);
    const sessions = r.sessions();
    for (let i = 0; i < times; i += 1) {
      await sessions.startSession(browser(), { userId: user, method: 'email' });
    }
    return user;
  }

  const sessionsOf = async (user: string) =>
    (await r.sql(`select count(*) from app.sessions where user_id = '${user}';`)).trim();

  it('--email deletes that person sessions only, and says how many', async () => {
    const a = await signedIn('rev-a@example.com', 3);
    const b = await signedIn('rev-b@example.com', 2);
    const result = await revoke(['--email', 'REV-A@example.com']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('revoke-sessions: ended 3 sessions\n');
    expect(await sessionsOf(a)).toBe('0');
    expect(await sessionsOf(b)).toBe('2');
  });

  it('--email for an address with no account exits 2 and changes nothing', async () => {
    const before = (await r.sql('select count(*) from app.sessions;')).trim();
    const result = await revoke(['--email', 'nobody-here@example.com']);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('nobody-here');
    expect((await r.sql('select count(*) from app.sessions;')).trim()).toBe(before);
  });

  it('--all deletes every session of every person', async () => {
    await signedIn('rev-c@example.com', 2);
    await signedIn('rev-d@example.com', 1);
    const total = Number((await r.sql('select count(*) from app.sessions;')).trim());
    const result = await revoke(['--all']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`revoke-sessions: ended ${String(total)} sessions\n`);
    expect((await r.sql('select count(*) from app.sessions;')).trim()).toBe('0');
  });
});
