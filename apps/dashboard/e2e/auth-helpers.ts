import { randomBytes, randomUUID } from 'node:crypto';
import { createPasswordHasher, parseAuthConfig } from '@drefyn/auth';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { countTo, nextMail } from './mailpit.ts';
import { ON_ORIGIN } from './fixtures.ts';
import { MAYA } from './people.ts';
import { roleUrl, serverEnv, stackFile } from './stack-env.ts';

type Context = Readonly<Record<string, string>>;

// Rows, not a page, because the claims here are about rows. Direct, since Playwright runs in
// a container with no docker command, and as the product's own roles and context, since
// Postgres refuses the superuser over a network.
async function asRole(role: string, passwordKey: string, statement: string, context: Context) {
  const client = new pg.Client(roleUrl(stackFile(), role, passwordKey));
  await client.connect();
  try {
    await client.query('begin');
    for (const [name, value] of Object.entries(context)) {
      await client.query('select set_config($1, $2, true)', [name, value]);
    }
    const result = await client.query({ text: statement, rowMode: 'array' });
    await client.query('commit');
    return (result.rows as unknown[][]).map((row) => row.join('|')).join('\n');
  } finally {
    await client.end();
  }
}

export const authSql = (statement: string): Promise<string> =>
  asRole('drefyn_auth', 'DREFYN_AUTH_PASSWORD', statement, {});

export const organizationSql = (organizationId: string, statement: string): Promise<string> =>
  asRole('drefyn_app', 'DREFYN_APP_PASSWORD', statement, {
    'drefyn.organization_id': organizationId,
    'drefyn.actor_user_id': MAYA.id,
  });

const userSql = (userId: string, statement: string): Promise<string> =>
  asRole('drefyn_app', 'DREFYN_APP_PASSWORD', statement, {
    'drefyn.user_id': userId,
    'drefyn.actor_user_id': userId,
  });

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
