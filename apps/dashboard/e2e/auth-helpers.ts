import { randomBytes, randomUUID } from 'node:crypto';
import { createPasswordHasher, parseAuthConfig } from '@drefyn/auth';
import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  withAuth,
  withOrganization,
  withUser,
  type Database,
} from '@drefyn/db';
import { idOf, userId } from '@drefyn/tenancy';
import { expect, type Page } from '@playwright/test';
import { sql, type RawBuilder } from 'kysely';
import { countTo, nextMail } from './mailpit.ts';
import { ON_ORIGIN } from './fixtures.ts';
import { MAYA } from './people.ts';
import { serverEnv } from './stack-env.ts';

const env = serverEnv(ON_ORIGIN);

const text = (rows: readonly unknown[]): string =>
  rows.map((row) => Object.values(row as object).join('|')).join('\n');

// Rows, not a page, because the claims here are about rows. Through the product's own roles
// and contexts: Postgres refuses the superuser over a network, and Playwright's container
// has no docker command.
export async function authSql(statement: string): Promise<string> {
  const db = await createAuthDatabase(parseAuthDatabaseConfig(env));
  try {
    return text((await withAuth(db, (tx) => sql.raw(statement).execute(tx))).rows);
  } finally {
    await closeDatabase(db);
  }
}

async function appSql(
  work: (db: Database, query: RawBuilder<unknown>) => Promise<{ rows: readonly unknown[] }>,
  statement: string,
): Promise<string> {
  const db = await createDatabase(parseDatabaseConfig(env));
  try {
    return text((await work(db, sql.raw(statement))).rows);
  } finally {
    await closeDatabase(db);
  }
}

export const organizationSql = (organizationId: string, statement: string): Promise<string> =>
  appSql(
    (db, query) =>
      withOrganization(
        db,
        { organizationId: idOf('org', organizationId), actorUserId: userId(MAYA.id) },
        (tx) => query.execute(tx),
      ),
    statement,
  );

export const userSql = (id: string, statement: string): Promise<string> =>
  appSql((db, query) => withUser(db, { userId: userId(id) }, (tx) => query.execute(tx)), statement);

export const uniqueAddress = (label: string): string =>
  `${label}-${randomBytes(5).toString('hex')}@example.dev`;

export async function askForCode(page: Page, address: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify/);
}

export async function signInByCode(page: Page, address: string): Promise<void> {
  const seen = await countTo(address);
  await askForCode(page, address);
  const { code } = await nextMail(address, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// A person who exists before the test, so a refusal below is about them and not about an
// address nobody has.
export async function seedPerson(address: string, password?: string): Promise<string> {
  const id = randomUUID();
  await authSql(
    `insert into app.users (id, email, email_normalized, email_verified_at)
     values ('${id}', '${address}', '${address}', now())`,
  );
  if (password !== undefined) {
    const { passwords } = parseAuthConfig(serverEnv(ON_ORIGIN));
    const hasher = createPasswordHasher({
      params: passwords.argon2,
      concurrency: passwords.hashConcurrency,
      queueMax: passwords.hashQueueMax,
    });
    const phc = await hasher.hash(password);
    await userSql(
      id,
      `insert into app.password_credentials (user_id, phc) values ('${id}', '${phc}')`,
    );
  }
  return id;
}

// How a session looks an hour after its last sign in, without waiting the hour.
export const makeStale = (id: string): Promise<string> =>
  userSql(id, `update app.sessions set authenticated_at = now() - interval '1 hour'`);

export const makeFresh = (id: string): Promise<string> =>
  userSql(id, `update app.sessions set authenticated_at = now()`);
