import { createHash, randomBytes } from 'node:crypto';
import { formatApiKey } from '@drefyn/auth';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  newId,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import { afterAll, describe, inject } from 'vitest';
import { cloneDatabase, dropDatabase, ident, newName } from './global-setup.ts';
import { ROLE_NAMES, superuser, urlFor, type Role } from './stack.ts';

export function describeWithStack(name: string, body: () => void): void {
  const absent = inject('apiStackAbsent');
  if (absent === null) describe(name, body);
  else describe.skip(`${name} [skipped, no compose stack: ${absent}]`, body);
}

export const RATE_KEY = randomBytes(32).toString('base64url');

export interface Harness {
  readonly name: string;
  readonly db: Database;
  readonly published: PublishedDatabase;
  // What the service reads, pointed at this file's database.
  readonly env: Readonly<Record<string, string>>;
  sql(text: string): Promise<string>;
  organization(): Promise<OrganizationId>;
  project(org: OrganizationId, product?: 'docs' | 'studio' | 'status'): Promise<ProjectId>;
  key(
    org: OrganizationId,
    scopes: readonly string[],
    projects?: readonly ProjectId[],
  ): Promise<string>;
  // Every failure the limiter has counted in this database.
  failures(): Promise<number>;
  // Takes a role's connect right away and ends its sessions, so its pool cannot reach the
  // database; the returned function gives it back.
  cutOff(role: Role): Promise<() => Promise<void>>;
}

// One database per file, cloned from the migrated template and dropped after the file.
export function harness() {
  const created: string[] = [];
  const open: (Database | PublishedDatabase)[] = [];
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDatabase(db).catch(() => undefined);
    for (const name of created.splice(0)) await dropDatabase(name);
  });
  return async (): Promise<Harness> => {
    const name = newName('f');
    created.push(name);
    await cloneDatabase(inject('apiTemplate'), name);
    const env = {
      DREFYN_DATABASE_URL: urlFor('app', name),
      DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', name),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_WAIT_MS: '2000',
      DREFYN_API_RATE_LIMIT_KEY: RATE_KEY,
    };
    const db = await createDatabase(parseDatabaseConfig(env));
    open.push(db);
    const published = await createPublishedDatabase(parsePublishedReaderConfig(env));
    open.push(published);
    const sql = (text: string) => superuser(text, name);
    let slugs = 0;
    // A key belongs to the membership that made it, so each organization gets an owner.
    const owners = new Map<string, string>();
    return {
      name,
      db,
      published,
      env,
      sql,
      async organization() {
        const id = newId('org');
        const user = newId('usr');
        const email = `o${randomBytes(4).toString('hex')}@example.com`;
        const membership = await sql(
          `insert into app.organizations (organization_id, name, plan_tier)
           values ('${id}', 'Acme', 'self_hosted');
           insert into app.users (id, email, email_normalized, email_verified_at)
           values ('${user}', '${email}', '${email}', now());
           insert into app.memberships (organization_id, user_id, role)
           values ('${id}', '${user}', 'owner') returning id;`,
        );
        owners.set(id, membership);
        return id;
      },
      async project(org, product = 'studio') {
        const id = newId('prj');
        slugs += 1;
        await sql(
          `insert into app.projects (id, organization_id, product, slug, name)
           values ('${id}', '${org}', '${product}', 'p-${String(slugs)}', 'Handbook');`,
        );
        return id;
      },
      // A real key: the secret is random, only its hash is stored, and the verifier proves it
      // exactly as it proves one minted in the dashboard.
      async key(org, scopes, projects) {
        const keyId = newId('key');
        const secret = randomBytes(32);
        const formatted = formatApiKey({ organizationId: org, keyId, secret });
        const hash = createHash('sha256').update(secret).digest('hex');
        const scopeList = scopes.map((s) => `'${s}'`).join(', ');
        await sql(
          `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
             project_scope, idempotency_key, request_hash, created_by)
           values ('${keyId}', '${org}', 'Integration', decode('${hash}', 'hex'),
             '${formatted.slice(-4)}', array[${scopeList}]::text[],
             '${projects === undefined ? 'all' : 'listed'}', '${keyId}',
             decode('${hash}', 'hex'), '${owners.get(org) ?? ''}');`,
        );
        for (const projectId of projects ?? []) {
          await sql(
            `insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
             values ('${org}', '${keyId}', '${projectId}');`,
          );
        }
        return formatted;
      },
      async failures() {
        return Number(await sql('select coalesce(sum(count), 0) from app.api_key_failures;'));
      },
      async cutOff(role) {
        const who = ROLE_NAMES[role];
        await superuser(`revoke connect on database ${ident(name)} from ${who};`);
        await superuser(
          `select count(pg_terminate_backend(pid)) from pg_stat_activity
           where datname = '${name}' and usename = '${who}';`,
        );
        return async () => {
          await superuser(`grant connect on database ${ident(name)} to ${who};`);
        };
      },
    };
  };
}
