// Real rows and real sessions for the e2e suite, on the stack from scripts/selfhost.sh up.
// People and organizations go in as the superuser because the tier and the fixed ids are
// what the tests need and no product path can choose them. Sessions come from the real
// startSession, so the guard under test has no test path. The cookies land in .auth, which
// is never committed and never uploaded.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessions, parseAuthConfig, type AuthLogger } from '@drefyn/auth';
import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
} from '@drefyn/db';
import { userId } from '@drefyn/tenancy';
import { ON_ORIGIN } from './fixtures.ts';
import {
  ACME_ID,
  ADA,
  BETA_ID,
  KESTREL_ID,
  MAYA,
  NOOR,
  OMAR,
  PEOPLE,
  RAFA,
  SAM,
  stateFile,
  TESS,
  VAULT_ID,
  VAULT_KEY_INSIDE_LIMIT,
  VAULT_KEY_PAST_LIMIT,
} from './people.ts';
import { refuseOutsideTests } from './seed-guard.ts';
import { roleUrl, serverEnv, stackFile } from './stack-env.ts';

refuseOutsideTests(process.env);

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const file = stackFile();

function check(result: ReturnType<typeof spawnSync>, step: string): void {
  if (result.status === 0) return;
  throw new Error(`${step} exited ${String(result.status)}: ${String(result.stderr)}`);
}

check(
  spawnSync(process.execPath, [`${repo}packages/cli/src/main.ts`, 'migrate', 'up'], {
    env: {
      ...process.env,
      DREFYN_MIGRATION_DATABASE_URL: roleUrl(file, 'drefyn_owner', 'DREFYN_OWNER_PASSWORD'),
      DREFYN_DATABASE_SSL: 'disable',
    },
    encoding: 'utf8',
  }),
  'migrate up',
);

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

const people = PEOPLE.map(
  (p) => `(${quoted(p.id)}, ${quoted(p.email)}, ${quoted(p.email)}, ${quoted(p.name)}, now())`,
).join(',\n');

const membership = (organization: string, who: string, role: string) =>
  `(${quoted(organization)}, ${quoted(who)}, ${quoted(role)})`;

// Keys with no creator are legal only once revoked, and both of these are. The job is put due
// here, before any server starts, so the first run of the first server meets these rows.
const vaultKey = (id: string, revoked: string) =>
  `(${quoted(id)}, ${quoted(VAULT_ID)}, 'Old', decode(repeat('ab', 32), 'hex'), 'a1b2',
    array['docs:read'], 'all', null, ${quoted(`seed-${id}`)}, decode(repeat('cd', 32), 'hex'),
    now() - interval '200 days', now() - interval '${revoked}')`;

const sql = `
insert into app.users (id, email, email_normalized, display_name, email_verified_at)
values ${people} on conflict do nothing;
insert into app.organizations (organization_id, name, plan_tier)
values (${quoted(ACME_ID)}, 'Acme', 'starter'), (${quoted(BETA_ID)}, 'Beta', 'starter'),
  (${quoted(KESTREL_ID)}, 'Kestrel', 'growth')
on conflict do nothing;
insert into app.organization_slugs (slug, organization_id)
values ('acme', ${quoted(ACME_ID)}), ('beta', ${quoted(BETA_ID)}),
  ('kestrel', ${quoted(KESTREL_ID)}) on conflict do nothing;
insert into app.memberships (organization_id, user_id, role)
values ${[
  membership(ACME_ID, MAYA.id, 'owner'),
  membership(ACME_ID, ADA.id, 'admin'),
  membership(ACME_ID, SAM.id, 'member'),
  membership(BETA_ID, NOOR.id, 'owner'),
  membership(KESTREL_ID, OMAR.id, 'owner'),
  membership(KESTREL_ID, TESS.id, 'admin'),
  membership(KESTREL_ID, RAFA.id, 'member'),
].join(', ')} on conflict do nothing;
insert into app.projects (organization_id, product, slug, name)
values (${quoted(KESTREL_ID)}, 'docs', 'handbook', 'Handbook') on conflict do nothing;
insert into app.organizations (organization_id, name, plan_tier)
values (${quoted(VAULT_ID)}, 'Vault', 'starter') on conflict do nothing;
insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
  project_scope, created_by, idempotency_key, request_hash, created_at, revoked_at)
values ${vaultKey(VAULT_KEY_PAST_LIMIT, '91 days')}, ${vaultKey(VAULT_KEY_INSIDE_LIMIT, '89 days')}
on conflict do nothing;
update app.scheduled_jobs set next_run_at = now(), last_run_at = null;
`;

check(
  spawnSync(
    'docker',
    [
      'compose',
      '-f',
      `${repo}deploy/compose.yaml`,
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'drefyn',
    ],
    { input: sql, encoding: 'utf8' },
  ),
  'seed rows',
);

const env = serverEnv(ON_ORIGIN);
const config = parseAuthConfig(env);
const db = await createDatabase(parseDatabaseConfig(env));
const authDb = await createAuthDatabase(parseAuthDatabaseConfig(env));
const logger: AuthLogger = { info: () => undefined, warn: () => undefined };
const sessions = createSessions(config, { db, authDb, logger });

try {
  for (const person of PEOPLE) {
    const { setCookies } = await sessions.startSession(
      { ip: '127.0.0.1', userAgent: 'seed', cookies: new Map() },
      { userId: userId(person.id), method: 'email' },
    );
    const path = stateFile(person);
    mkdirSync(dirname(path), { recursive: true });
    const cookies = setCookies.map(({ name, value }) => ({
      name,
      value,
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    }));
    writeFileSync(path, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  }
} finally {
  await closeDatabase(db);
  await closeDatabase(authDb);
}
