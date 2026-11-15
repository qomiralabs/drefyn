import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER = '01a14984-4476-77ce-9335-1280000007a1';
const OTHER = '01a14984-4476-77ce-9335-1280000007b1';
const ORG = '01a14984-4476-77ce-9335-1280000007a2';
const CONN = '01a14984-4476-77ce-9335-1280000007a3';

const hash = (n: number) => `decode(lpad(to_hex(${String(n)}), 64, '0'), 'hex')`;

// SQLSTATE, and the constraint when Postgres names one, so a refusal is pinned to its rule.
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return constraint === undefined ? String(code) : `${String(code)} ${constraint}`;
  }
  return 'no error';
}

const linkSql = (provider: string, org: string | null, conn: string | null) =>
  `insert into app.email_challenges (email_normalized, purpose, user_id, code_hmac, browser_hash,
       pending_provider, pending_subject, pending_sso_organization_id, pending_sso_connection_id,
       expires_at)
     values ('sso-in@example.com', 'link_identity', '${USER}', ${hash(1)}, ${hash(2)},
             ${provider === 'null' ? 'null' : `'${provider}'`}, 'subject',
             ${org === null ? 'null' : `'${org}'`}, ${conn === null ? 'null' : `'${conn}'`},
             now() + interval '10 minutes')`;

const factorSql = (method: string, conn: string | null, org: string | null) =>
  `insert into app.factor_challenges (user_id, secret_hash, method, sso_connection_id,
       sso_organization_id, expires_at)
     values ('${USER}', ${hash(3)}, '${method}', ${conn === null ? 'null' : `'${conn}'`},
             ${org === null ? 'null' : `'${org}'`}, now() + interval '10 minutes')`;

const seedSql = (jit: boolean, status: string, role: string) => `
  insert into app.users (id, email, email_normalized, email_verified_at) values
    ('${USER}', 'sso-in@example.com', 'sso-in@example.com', now()),
    ('${OTHER}', 'sso-other@example.com', 'sso-other@example.com', now());
  insert into app.organizations (organization_id, name, plan_tier)
    values ('${ORG}', 'A', 'self_hosted');
  insert into app.sso_connections (id, organization_id, protocol, display_name, status,
      jit_enabled, jit_default_project_role, idempotency_key)
    values ('${CONN}', '${ORG}', 'oidc', 'Okta', '${status}', ${String(jit)}, ${role}, 'k1');
  insert into app.sso_identities (organization_id, connection_id, user_id, subject, email_normalized)
    values ('${ORG}', '${CONN}', '${USER}', 'subject', 'sso-in@example.com');`;

describeWithStack('the sso sign in migration', () => {
  it('reverts cleanly, applies over rows written before it, and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await superuser(
      `${seedSql(true, 'active', "'viewer'")}
       ${linkSql('sso', ORG, CONN)}; ${linkSql('github', null, null)};
       ${factorSql('sso', CONN, ORG)};`,
      db.name,
    );
    const shipped = shippedMigrations();
    const at = shipped.findIndex((file) => file.endsWith('_sso_sign_in.sql'));
    expect(at).toBeGreaterThanOrEqual(0);
    const step = async (args: readonly string[]) => {
      const result = await migrate(args, { url: db.owner });
      expect(result.code, describeFailure(result)).toBe(0);
    };
    await step(['migrate', 'down', String(shipped.length - at)]);
    // The older checks refuse the SSO rows, so the down removes those and keeps the rest.
    expect(
      await superuser(
        `select string_agg(coalesce(pending_provider, '-'), ',') from app.email_challenges;
         select count(*) from app.factor_challenges;
         select has_column_privilege('drefyn_auth', 'app.sso_identities', 'last_used_at', 'update');`,
        db.name,
      ).then((out) => out.trim()),
    ).toBe('github\n0\nf');
    await expect(
      superuser(
        `begin;
         insert into app.email_challenges (email_normalized, purpose, code_hmac, browser_hash,
             pending_provider, pending_subject, expires_at)
           values ('x@example.com', 'link_identity', ${hash(5)}, ${hash(6)}, 'sso', 's',
                   now() + interval '10 minutes');
         rollback;`,
        db.name,
      ),
    ).rejects.toThrow(/email_challenges_pending_provider_check/);

    await step(['migrate', 'up']);
    expect(
      await superuser(
        `select coalesce(pending_sso_connection_id::text, '-') from app.email_challenges;
         select has_column_privilege('drefyn_auth', 'app.sso_identities', 'last_used_at', 'update');`,
        db.name,
      ).then((out) => out.trim()),
    ).toBe('-\nt');
    await superuser(
      `begin; ${linkSql('sso', ORG, CONN)}; ${factorSql('sso', CONN, ORG)}; rollback;`,
      db.name,
    );
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});

describeWithStack('what sso sign in writes', () => {
  let db: TestDatabase;
  const open: pg.Client[] = [];
  const as = async (role: 'app' | 'auth') => {
    const client = await rawSession(role, db.name);
    open.push(client);
    return client;
  };

  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(seedSql(true, 'active', "'viewer'"), db.name);
  });

  afterAll(async () => {
    for (const client of open.splice(0)) await client.end().catch(() => undefined);
  });

  describe('a pending link', () => {
    it.each([
      ['an SSO link with both ids', 'sso', ORG, CONN, true],
      ['a provider link with neither', 'github', null, null, true],
      ['no link with neither', 'null', null, null, true],
      ['an SSO link without ids', 'sso', null, null, false],
      ['an SSO link with one id', 'sso', ORG, null, false],
      ['a provider link with ids', 'google', ORG, CONN, false],
      ['no link with ids', 'null', ORG, CONN, false],
    ])('takes %s only when the pair matches the provider', async (_l, provider, org, conn, ok) => {
      const run = superuser(`begin; ${linkSql(provider, org, conn)}; rollback;`, db.name);
      if (ok) await run;
      else await expect(run).rejects.toThrow(/email_challenges_pending_sso_check/);
    });
  });

  describe('a factor challenge', () => {
    it.each([
      ['sso with both ids', 'sso', CONN, ORG, true],
      ['email with neither', 'email', null, null, true],
      ['sso without ids', 'sso', null, null, false],
      ['sso with one id', 'sso', CONN, null, false],
      ['email with ids', 'email', CONN, ORG, false],
    ])('takes %s only when the pair matches the method', async (_label, method, conn, org, ok) => {
      const run = superuser(`begin; ${factorSql(method, conn, org)}; rollback;`, db.name);
      if (ok) await run;
      else await expect(run).rejects.toThrow(/factor_challenges_sso_check/);
    });

    it('lets the person write the SSO columns of their own challenge', async () => {
      const app = await as('app');
      await app.query('begin');
      try {
        await app.query(`select set_config('drefyn.user_id', $1, true)`, [USER]);
        await app.query(
          `insert into app.factor_challenges (user_id, secret_hash, method, sso_connection_id,
               sso_organization_id, expires_at)
             values ($1, ${hash(4)}, 'sso', $2, $3, now() + interval '10 minutes')`,
          [USER, CONN, ORG],
        );
        const { rows } = await app.query<{ sso_connection_id: string }>(
          'select sso_connection_id from app.factor_challenges',
        );
        expect(rows.map((r) => r.sso_connection_id)).toEqual([CONN]);
      } finally {
        await app.query('rollback');
      }
    });
  });

  describe('the sign in role on a link', () => {
    it('updates when the link was last used and nothing else', async () => {
      const auth = await as('auth');
      await auth.query('begin');
      try {
        const { rows } = await auth.query<{ fresh: boolean }>(
          `update app.sso_identities set last_used_at = now()
             where organization_id = $1 and connection_id = $2 and subject = 'subject'
             returning last_used_at = now() as fresh`,
          [ORG, CONN],
        );
        expect(rows).toEqual([{ fresh: true }]);
      } finally {
        await auth.query('rollback');
      }
      for (const column of ['user_id', 'subject', 'organization_id', 'email_normalized']) {
        await auth.query('begin');
        try {
          expect(
            await refusal(
              auth.query(`update app.sso_identities set ${column} = ${column} where subject = 'x'`),
            ),
            column,
          ).toBe('42501');
        } finally {
          await auth.query('rollback');
        }
      }
    });
  });

  describe('a just in time membership', () => {
    // Organization work acting as actor, inserting a membership for user.
    async function insert(
      actor: string,
      user: string,
      role: string,
      projectRole: string | null,
      setup = '',
    ): Promise<string> {
      if (setup !== '') await superuser(setup, db.name);
      const app = await as('app');
      await app.query('begin');
      try {
        await app.query(
          `select set_config('drefyn.organization_id', $1, true),
                  set_config('drefyn.actor_user_id', $2, true)`,
          [ORG, actor],
        );
        return await refusal(
          app.query(
            `insert into app.memberships (organization_id, user_id, role, default_project_role)
               values ($1, $2, $3, $4)`,
            [ORG, user, role, projectRole],
          ),
        );
      } finally {
        await app.query('rollback');
      }
    }

    const reset = `update app.sso_connections set status = 'active', jit_enabled = true,
                     jit_default_project_role = 'viewer' where id = '${CONN}';`;

    it('is born as member with the connection project role for the linked person', async () => {
      expect(await insert(USER, USER, 'member', 'viewer', reset)).toBe('no error');
    });

    it.each([
      ['an admin role', USER, USER, 'admin', 'viewer', ''],
      ['another project role', USER, USER, 'member', 'editor', ''],
      ['no project role when the connection has one', USER, USER, 'member', null, ''],
      ['a person with no link here', OTHER, OTHER, 'member', 'viewer', ''],
      ['someone acting for the linked person', OTHER, USER, 'member', 'viewer', ''],
      [
        'a connection in test',
        USER,
        USER,
        'member',
        'viewer',
        `update app.sso_connections set status = 'test' where id = '${CONN}';`,
      ],
      [
        'a disabled connection',
        USER,
        USER,
        'member',
        'viewer',
        `update app.sso_connections set status = 'disabled' where id = '${CONN}';`,
      ],
      [
        'just in time off',
        USER,
        USER,
        'member',
        'viewer',
        `update app.sso_connections set jit_enabled = false where id = '${CONN}';`,
      ],
    ])('is refused for %s', async (_label, actor, user, role, projectRole, setup) => {
      await superuser(reset, db.name);
      expect(await insert(actor, user, role, projectRole, setup)).toBe('42501');
    });

    it('takes a null project role when the connection has none', async () => {
      await superuser(reset, db.name);
      const none = `update app.sso_connections set jit_default_project_role = null
                      where id = '${CONN}';`;
      expect(await insert(USER, USER, 'member', null, none)).toBe('no error');
      expect(await insert(USER, USER, 'member', 'viewer', none)).toBe('42501');
    });

    it('still refuses organization work that tries to link an identity itself', async () => {
      const app = await as('app');
      await app.query('begin');
      try {
        await app.query(
          `select set_config('drefyn.organization_id', $1, true),
                  set_config('drefyn.actor_user_id', $2, true)`,
          [ORG, OTHER],
        );
        expect(
          await refusal(
            app.query(
              `insert into app.sso_identities (organization_id, connection_id, user_id, subject,
                   email_normalized) values ($1, $2, $3, 'forged', 'sso-other@example.com')`,
              [ORG, CONN, OTHER],
            ),
          ),
        ).toBe('42501');
      } finally {
        await app.query('rollback');
      }
    });
  });
});
