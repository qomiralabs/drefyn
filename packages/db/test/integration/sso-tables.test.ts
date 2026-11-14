import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../src/allow-lists.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems, rawSession } from './support/tenancy.ts';

const dbs = databases();

const USER_A = '01a14984-4476-77ce-9335-1280000005a1';
const USER_B = '01a14984-4476-77ce-9335-1280000005b1';
const ORG_A = '01a14984-4476-77ce-9335-1280000005a2';
const ORG_B = '01a14984-4476-77ce-9335-1280000005b2';
const CONN_A = '01a14984-4476-77ce-9335-1280000005a3';
const CONN_B = '01a14984-4476-77ce-9335-1280000005b3';
const DOMAIN_A = '01a14984-4476-77ce-9335-1280000005a4';
const DOMAIN_B = '01a14984-4476-77ce-9335-1280000005b4';
const DOMAIN_A_DRAFT = '01a14984-4476-77ce-9335-1280000005a5';

const TENANT_TABLES = ['sso_connections', 'sso_domains', 'sso_identities'] as const;
const ALL_TABLES = [...TENANT_TABLES, 'sso_states'] as const;

let db: TestDatabase;
const sessions: pg.Client[] = [];

async function as(role: 'app' | 'auth'): Promise<pg.Client> {
  const client = await rawSession(role, db.name);
  sessions.push(client);
  return client;
}

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

interface Context {
  readonly org?: string;
  readonly user?: string;
}

async function begin(client: pg.Client, context: Context): Promise<void> {
  await client.query('begin');
  await client.query(
    `select set_config('drefyn.organization_id', $1, true), set_config('drefyn.project_id', '', true),
            set_config('drefyn.user_id', $2, true), set_config('drefyn.actor_user_id', $3, true)`,
    [context.org ?? '', context.user ?? '', context.org === undefined ? '' : USER_A],
  );
}

// Each case rolls back, so every case sees the seeded rows.
async function rolledBack<T>(
  client: pg.Client,
  context: Context,
  work: () => Promise<T>,
): Promise<T> {
  await begin(client, context);
  try {
    return await work();
  } finally {
    await client.query('rollback');
  }
}

async function committed(
  client: pg.Client,
  context: Context,
  work: () => Promise<unknown>,
): Promise<void> {
  await begin(client, context);
  try {
    await work();
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

const hash = (n: number) => `decode(lpad(to_hex(${String(n)}), 64, '0'), 'hex')`;

const connectionSql = (id: string, org: string, over: Record<string, string> = {}) => {
  const values: Record<string, string> = {
    id: `'${id}'`,
    organization_id: `'${org}'`,
    protocol: "'oidc'",
    display_name: "'Okta'",
    oidc_issuer: "'https://acme.okta.com'",
    oidc_client_id: "'client'",
    oidc_client_secret_sealed: hash(1),
    idempotency_key: `'k-${id}'`,
    ...over,
  };
  return `insert into app.sso_connections (${Object.keys(values).join(', ')})
            values (${Object.values(values).join(', ')})`;
};

const domainSql = (id: string, org: string, conn: string, domain: string, verified: boolean) =>
  `insert into app.sso_domains (id, organization_id, connection_id, domain, txt_token_hash, verified_at)
     values ('${id}', '${org}', '${conn}', '${domain}', ${hash(2)}, ${verified ? 'now()' : 'null'})`;

const identitySql = (org: string, conn: string, user: string, subject: string) =>
  `insert into app.sso_identities (organization_id, connection_id, user_id, subject, email_normalized)
     values ('${org}', '${conn}', '${user}', '${subject}', '${subject}@example.com')`;

const stateSql = (n: number, org: string, conn: string) =>
  `insert into app.sso_states (state_hash, organization_id, connection_id, protocol, code_verifier,
       nonce, browser_hash, expires_at)
     values (${hash(n)}, '${org}', '${conn}', 'oidc', repeat('v', 43), repeat('n', 22), ${hash(n)},
             now() + interval '10 minutes')`;

const sessionSql = (user: string, method: string, conn: string | null, org: string | null) =>
  `insert into app.sessions (user_id, secret_hash, method, authenticated_at, expires_at,
       sso_connection_id, sso_organization_id)
     values ('${user}', ${hash(9)}, '${method}', now(), now() + interval '1 day',
             ${conn === null ? 'null' : `'${conn}'`}, ${org === null ? 'null' : `'${org}'`})`;

async function seed(): Promise<void> {
  await superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at) values
       ('${USER_A}', 'sso-a@example.com', 'sso-a@example.com', now()),
       ('${USER_B}', 'sso-b@example.com', 'sso-b@example.com', now());
     insert into app.organizations (organization_id, name, plan_tier) values
       ('${ORG_A}', 'A', 'self_hosted'), ('${ORG_B}', 'B', 'self_hosted');
     ${connectionSql(CONN_A, ORG_A)};
     ${connectionSql(CONN_B, ORG_B)};
     ${domainSql(DOMAIN_A, ORG_A, CONN_A, 'a.example', true)};
     ${domainSql(DOMAIN_A_DRAFT, ORG_A, CONN_A, 'draft.example', false)};
     ${domainSql(DOMAIN_B, ORG_B, CONN_B, 'b.example', true)};
     ${identitySql(ORG_A, CONN_A, USER_A, 'a-subject')};
     ${identitySql(ORG_B, CONN_B, USER_A, 'a-at-b')};
     ${identitySql(ORG_B, CONN_B, USER_B, 'b-subject')};
     ${stateSql(1, ORG_A, CONN_A)};`,
    db.name,
  );
}

const CONNECTION_LOOKUP = [
  'id',
  'organization_id',
  'protocol',
  'status',
  'display_name',
  'oidc_issuer',
  'oidc_client_id',
  'oidc_endpoints',
  'saml_idp_entity_id',
  'saml_idp_sso_url',
  'saml_idp_certs',
  'jit_enabled',
  'jit_default_project_role',
  'session_max_seconds',
];

describeWithStack('sso tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await seed();
  });

  afterAll(async () => {
    for (const client of sessions.splice(0)) await client.end().catch(() => undefined);
  });

  describe('catalog', () => {
    it.each(ALL_TABLES)('forces row level security on %s', async (table) => {
      const flags = await superuser(
        `select relrowsecurity::text || ',' || relforcerowsecurity::text
           from pg_class where oid = 'app.${table}'::regclass;`,
        db.name,
      );
      expect(flags.trim()).toBe('true,true');
    });

    it('passes, and fails without each new allow list entry', async () => {
      expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
      for (const table of ALL_TABLES) {
        const name = `app.${table}`;
        const scoped: AllowLists = {
          ...ALLOW_LISTS,
          organizationTables: ALLOW_LISTS.organizationTables.filter((e) => e.name !== name),
        };
        expect(await catalogProblems(db.owner, scoped), name).toContainEqual(
          expect.objectContaining({ rule: 'organization_table', object: name }),
        );
      }
      const unique: AllowLists = {
        ...ALLOW_LISTS,
        globalUniqueConstraints: ALLOW_LISTS.globalUniqueConstraints.filter(
          (e) => e.name !== 'app.sso_domains.sso_domains_verified_domain_key',
        ),
      };
      expect(await catalogProblems(db.owner, unique)).toContainEqual(
        expect.objectContaining({ rule: 'tenant_unique', object: 'app.sso_domains' }),
      );
      const auth: AllowLists = {
        ...ALLOW_LISTS,
        authTenantGrants: ALLOW_LISTS.authTenantGrants.filter(
          (g) => g.name !== 'app.sso_identities.subject',
        ),
      };
      expect(await catalogProblems(db.owner, auth)).toContainEqual(
        expect.objectContaining({ rule: 'auth_grant', object: 'app.sso_identities' }),
      );
    });

    // Sign in state is the sign in role's alone; organization work has no reason to see it.
    it('gives drefyn_app no privilege on sso_states', async () => {
      const privileges = await superuser(
        `select string_agg(p || '=' || has_table_privilege('drefyn_app', 'app.sso_states', p)::text, ',' order by p)
           from unnest(array['select', 'insert', 'update', 'delete']) p;`,
        db.name,
      );
      expect(privileges.trim()).toBe('delete=false,insert=false,select=false,update=false');
    });
  });

  describe('one organization under drefyn_app', () => {
    it.each(TENANT_TABLES)('reads only its own rows of %s', async (table) => {
      const client = await as('app');
      const read = await rolledBack(client, { org: ORG_A }, () =>
        client.query<{ organization_id: string }>(
          `select distinct organization_id from app.${table}`,
        ),
      );
      expect(read.rows).toEqual([{ organization_id: ORG_A }]);
    });

    it('cannot write a connection or a domain into another organization', async () => {
      const client = await as('app');
      const connection = await rolledBack(client, { org: ORG_A }, () =>
        refusal(client.query(connectionSql('01a14984-4476-77ce-9335-1280000005c3', ORG_B))),
      );
      expect(connection).toBe('42501');
      const domain = await rolledBack(client, { org: ORG_A }, () =>
        refusal(
          client.query(
            domainSql('01a14984-4476-77ce-9335-1280000005c4', ORG_B, CONN_B, 'c.example', false),
          ),
        ),
      );
      expect(domain).toBe('42501');
    });

    it('updates and deletes nothing of another organization', async () => {
      const client = await as('app');
      for (const table of TENANT_TABLES) {
        const deleted = await rolledBack(client, { org: ORG_A }, () =>
          client.query(`delete from app.${table} where organization_id = $1`, [ORG_B]),
        );
        expect(deleted.rowCount, table).toBe(0);
      }
      const renamed = await rolledBack(client, { org: ORG_A }, () =>
        client.query(`update app.sso_connections set display_name = 'x' where id = $1`, [CONN_B]),
      );
      expect(renamed.rowCount).toBe(0);
    });

    // An organization admin who could write an identity row could map their own IdP subject
    // onto anyone's account. Only sign in links an identity.
    it('cannot insert or update an identity, only read and unlink one', async () => {
      const client = await as('app');
      const insert = await rolledBack(client, { org: ORG_A }, () =>
        refusal(client.query(identitySql(ORG_A, CONN_A, USER_B, 'stolen'))),
      );
      expect(insert).toBe('42501');
      const update = await rolledBack(client, { org: ORG_A }, () =>
        refusal(client.query(`update app.sso_identities set user_id = $1`, [USER_B])),
      );
      expect(update).toBe('42501');
      const unlinked = await rolledBack(client, { org: ORG_A }, () =>
        client.query('delete from app.sso_identities'),
      );
      expect(unlinked.rowCount).toBe(1);
    });

    it('cannot change who made a connection, or its key', async () => {
      const client = await as('app');
      for (const column of ['organization_id', 'created_by', 'idempotency_key', 'protocol']) {
        const changed = await rolledBack(client, { org: ORG_A }, () =>
          refusal(client.query(`update app.sso_connections set ${column} = ${column}`)),
        );
        expect(changed, column).toBe('42501');
      }
    });
  });

  describe('a person under drefyn_app', () => {
    it('reads their own identities across organizations and nobody else', async () => {
      const client = await as('app');
      const own = await rolledBack(client, { user: USER_A }, () =>
        client.query<{ subject: string }>(
          'select subject from app.sso_identities order by subject',
        ),
      );
      expect(own.rows.map((r) => r.subject)).toEqual(['a-at-b', 'a-subject']);
      const none = await rolledBack(client, {}, () =>
        client.query('select 1 from app.sso_identities'),
      );
      expect(none.rowCount).toBe(0);
    });

    it('reads no connection or domain without an organization', async () => {
      const client = await as('app');
      for (const table of ['sso_connections', 'sso_domains']) {
        const read = await rolledBack(client, { user: USER_A }, () =>
          client.query(`select 1 from app.${table}`),
        );
        expect(read.rowCount, table).toBe(0);
      }
    });
  });

  describe('drefyn_auth', () => {
    it('reads the connection lookup columns of every organization', async () => {
      const client = await as('auth');
      const read = await rolledBack(client, {}, () =>
        client.query<{ id: string }>(
          `select ${CONNECTION_LOOKUP.join(', ')} from app.sso_connections order by id`,
        ),
      );
      expect(read.rows.map((r) => r.id)).toEqual([CONN_A, CONN_B]);
    });

    it.each([
      'oidc_client_secret_sealed',
      'version',
      'created_by',
      'idempotency_key',
      'created_at',
      'updated_at',
    ])('is refused sso_connections.%s', async (column) => {
      const client = await as('auth');
      const read = await rolledBack(client, {}, () =>
        refusal(client.query(`select ${column} from app.sso_connections`)),
      );
      expect(read).toBe('42501');
    });

    it('is refused select * and every write on sso_connections', async () => {
      const client = await as('auth');
      for (const statement of [
        'select * from app.sso_connections',
        connectionSql('01a14984-4476-77ce-9335-1280000005d3', ORG_A),
        "update app.sso_connections set status = 'active'",
        'delete from app.sso_connections',
      ]) {
        const result = await rolledBack(client, {}, () => refusal(client.query(statement)));
        expect(result, statement).toBe('42501');
      }
    });

    it('finds verified domains for discovery and never the token hash', async () => {
      const client = await as('auth');
      const read = await rolledBack(client, {}, () =>
        client.query<{ domain: string }>(
          'select domain, organization_id, connection_id, verified_at from app.sso_domains order by domain',
        ),
      );
      expect(read.rows.map((r) => r.domain)).toEqual(['a.example', 'b.example']);
      for (const statement of [
        'select txt_token_hash from app.sso_domains',
        'select failed_checks from app.sso_domains',
        "update app.sso_domains set verified_at = now() where domain = 'draft.example'",
      ]) {
        const result = await rolledBack(client, {}, () => refusal(client.query(statement)));
        expect(result, statement).toBe('42501');
      }
    });

    it('reads and inserts identities, and changes none', async () => {
      const client = await as('auth');
      const read = await rolledBack(client, {}, () =>
        client.query(
          'select id, organization_id, connection_id, user_id, subject, email_normalized, last_used_at, created_at from app.sso_identities',
        ),
      );
      expect(read.rowCount).toBe(3);
      const inserted = await rolledBack(client, {}, () =>
        client.query(identitySql(ORG_A, CONN_A, USER_B, 'b-at-a')),
      );
      expect(inserted.rowCount).toBe(1);
      for (const statement of [
        `update app.sso_identities set user_id = '${USER_B}'`,
        'delete from app.sso_identities',
      ]) {
        const result = await rolledBack(client, {}, () => refusal(client.query(statement)));
        expect(result, statement).toBe('42501');
      }
    });

    it('writes, reads and consumes a state', async () => {
      const client = await as('auth');
      const consumed = await rolledBack(client, {}, async () => {
        await client.query(stateSql(2, ORG_B, CONN_B));
        return client.query<{ organization_id: string }>(
          `delete from app.sso_states where state_hash = ${hash(2)} returning organization_id, connection_id, protocol, code_verifier, nonce`,
        );
      });
      expect(consumed.rows).toEqual([expect.objectContaining({ organization_id: ORG_B })]);
      const update = await rolledBack(client, {}, () =>
        refusal(client.query("update app.sso_states set return_to = '/x'")),
      );
      expect(update).toBe('42501');
    });
  });

  describe('domain ownership', () => {
    it('lets two organizations claim one domain, and only one verify it', async () => {
      const client = await as('app');
      const claimA = '01a14984-4476-77ce-9335-1280000005e1';
      const claimB = '01a14984-4476-77ce-9335-1280000005e2';
      try {
        await committed(client, { org: ORG_A }, () =>
          client.query(domainSql(claimA, ORG_A, CONN_A, 'example.com', false)),
        );
        await committed(client, { org: ORG_B }, () =>
          client.query(domainSql(claimB, ORG_B, CONN_B, 'example.com', false)),
        );
        await committed(client, { org: ORG_A }, () =>
          client.query('update app.sso_domains set verified_at = now() where id = $1', [claimA]),
        );
        const second = await rolledBack(client, { org: ORG_B }, () =>
          refusal(
            client.query('update app.sso_domains set verified_at = now() where id = $1', [claimB]),
          ),
        );
        expect(second).toBe('23505 sso_domains_verified_domain_key');
      } finally {
        await superuser(
          `delete from app.sso_domains where id in ('${claimA}', '${claimB}');`,
          db.name,
        );
      }
    });

    it('refuses a second claim of a domain inside one organization', async () => {
      const client = await as('app');
      const second = await rolledBack(client, { org: ORG_A }, () =>
        refusal(
          client.query(
            domainSql('01a14984-4476-77ce-9335-1280000005e3', ORG_A, CONN_A, 'a.example', false),
          ),
        ),
      );
      expect(second).toBe('23505 sso_domains_organization_domain_key');
    });

    it.each(['Example.com', 'example', '-x.example', 'x..example', 'exämple.com', ' a.example'])(
      'refuses the domain %j',
      async (domain) => {
        const client = await as('app');
        const result = await rolledBack(client, { org: ORG_A }, () =>
          refusal(
            client.query(
              domainSql('01a14984-4476-77ce-9335-1280000005e4', ORG_A, CONN_A, domain, false),
            ),
          ),
        );
        expect(result).toBe('23514 sso_domains_domain_check');
      },
    );
  });

  describe('checks', () => {
    const NEW = '01a14984-4476-77ce-9335-1280000005f1';

    async function insertConnection(over: Record<string, string>): Promise<string> {
      const client = await as('app');
      return rolledBack(client, { org: ORG_A }, () =>
        refusal(client.query(connectionSql(NEW, ORG_A, over))),
      );
    }

    it.each<[string, Record<string, string>, string]>([
      ['an unknown protocol', { protocol: "'ldap'" }, 'sso_connections_protocol_check'],
      ['an unknown status', { status: "'live'" }, 'sso_connections_status_check'],
      [
        'a session cap under an hour',
        { session_max_seconds: '3599' },
        'sso_connections_session_max_seconds_check',
      ],
      [
        'a session cap over 30 days',
        { session_max_seconds: '2592001' },
        'sso_connections_session_max_seconds_check',
      ],
      [
        'four IdP certificates',
        { saml_idp_certs: "array['a', 'b', 'c', 'd']" },
        'sso_connections_saml_idp_certs_check',
      ],
      [
        'a null IdP certificate',
        { saml_idp_certs: "array['a', null]" },
        'sso_connections_saml_idp_certs_check',
      ],
      [
        'an owner project role',
        { jit_default_project_role: "'owner'" },
        'sso_connections_jit_default_project_role_check',
      ],
    ])('refuse %s', async (_label, over, constraint) => {
      expect(await insertConnection(over)).toBe(`23514 ${constraint}`);
    });

    it.each<[string, Record<string, string>]>([
      ['an hour cap', { session_max_seconds: '3600' }],
      ['a 30 day cap', { session_max_seconds: '2592000' }],
      ['no cap', { session_max_seconds: 'null' }],
      ['three IdP certificates', { protocol: "'saml'", saml_idp_certs: "array['a', 'b', 'c']" }],
    ])('accept %s', async (_label, over) => {
      expect(await insertConnection(over)).toBe('no error');
    });

    it('start a connection as a draft with JIT off', async () => {
      const row = await superuser(
        `select status || ',' || jit_enabled::text || ',' || version::text
           from app.sso_connections where id = '${CONN_A}';`,
        db.name,
      );
      expect(row.trim()).toBe('draft,false,1');
    });

    it('start every organization with enforcement off, and refuse an unknown mode', async () => {
      const row = await superuser(
        `select sso_enforcement || ',' || coalesce(sso_enforcement_since::text, '-')
           from app.organizations where organization_id = '${ORG_A}';`,
        db.name,
      );
      expect(row.trim()).toBe('off,-');
      await expect(
        superuser(
          `update app.organizations set sso_enforcement = 'on' where organization_id = '${ORG_A}';`,
          db.name,
        ),
      ).rejects.toThrow(/organizations_sso_enforcement_check/);
      await expect(
        superuser(
          `update app.organizations set sso_enforcement = 'everyone' where organization_id = '${ORG_A}';`,
          db.name,
        ),
      ).rejects.toThrow(/organizations_sso_enforcement_since/);
      await superuser(
        `begin;
         update app.organizations set sso_enforcement = 'everyone', sso_enforcement_since = now()
          where organization_id = '${ORG_A}';
         update app.organizations set sso_enforcement = 'verified_domains'
          where organization_id = '${ORG_A}';
         rollback;`,
        db.name,
      );
    });

    // Organization work cannot switch enforcement on for itself until the enforcement work
    // grants it, with its own checks.
    it('leave enforcement unwritable by organization work', async () => {
      const client = await as('app');
      const result = await rolledBack(client, { org: ORG_A }, () =>
        refusal(client.query("update app.organizations set sso_enforcement = 'everyone'")),
      );
      expect(result).toBe('42501');
    });

    it.each<[string, string, string | null, string | null, string]>([
      ['an unknown method', 'saml', null, null, '23514 sessions_method_check'],
      ['only a connection', 'sso', CONN_A, null, '23514 sessions_sso_check'],
      ['only an organization', 'sso', null, ORG_A, '23514 sessions_sso_check'],
      ['sso without either', 'sso', null, null, '23514 sessions_sso_check'],
      ['email with a connection', 'email', CONN_A, ORG_A, '23514 sessions_sso_check'],
      ['sso with both', 'sso', CONN_A, ORG_A, 'no error'],
      ['email with neither', 'email', null, null, 'no error'],
    ])('on a session, answer %s with %s', async (_label, method, conn, org, expected) => {
      const client = await as('app');
      const result = await rolledBack(client, { user: USER_A }, () =>
        refusal(client.query(sessionSql(USER_A, method, conn, org))),
      );
      expect(result).toBe(expected);
    });

    it('refuse a state whose fields do not match its protocol', async () => {
      const client = await as('auth');
      const result = await rolledBack(client, {}, () =>
        refusal(
          client.query(
            `insert into app.sso_states (state_hash, organization_id, connection_id, protocol,
                 code_verifier, browser_hash, expires_at)
               values (${hash(5)}, '${ORG_A}', '${CONN_A}', 'saml', repeat('v', 43), ${hash(5)}, now())`,
          ),
        ),
      );
      expect(result).toBe('23514 sso_states_protocol_fields');
    });
  });

  describe('deletes', () => {
    it('remove a person identities with the person', async () => {
      const user = '01a14984-4476-77ce-9335-1280000005f9';
      await superuser(
        `insert into app.users (id, email, email_normalized, email_verified_at)
           values ('${user}', 'gone@example.com', 'gone@example.com', now());
         ${identitySql(ORG_A, CONN_A, user, 'gone')};
         delete from app.users where id = '${user}';`,
        db.name,
      );
      const left = await superuser(
        `select count(*) from app.sso_identities where user_id = '${user}';`,
        db.name,
      );
      expect(left.trim()).toBe('0');
    });

    it('remove domains, identities and states with their connection', async () => {
      const left = await superuser(
        `begin;
         delete from app.sso_connections where id = '${CONN_A}';
         select (select count(*) from app.sso_domains where connection_id = '${CONN_A}') +
                (select count(*) from app.sso_identities where connection_id = '${CONN_A}') +
                (select count(*) from app.sso_states where connection_id = '${CONN_A}');
         rollback;`,
        db.name,
      );
      expect(left.trim()).toBe('0');
    });
  });
});
