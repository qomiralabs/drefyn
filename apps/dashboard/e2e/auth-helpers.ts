import { randomBytes, randomUUID } from 'node:crypto';
import { createPasswordHasher, parseAuthConfig } from '@drefyn/auth';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { countTo, nextMail } from './mailpit.ts';
import { ON_ORIGIN } from './fixtures.ts';
import { roleUrl, serverEnv, stackFile } from './stack-env.ts';

// Rows, not a page, because the claims here are about rows. Direct, since Playwright runs in
// a container with no docker command.
export async function sql(statement: string): Promise<string> {
  const client = new pg.Client(roleUrl(stackFile(), 'postgres', 'DREFYN_POSTGRES_PASSWORD'));
  await client.connect();
  try {
    const result = await client.query({ text: statement, rowMode: 'array' });
    return (result.rows as unknown[][]).map((row) => row.join('|')).join('\n');
  } finally {
    await client.end();
  }
}

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
  await sql(
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
    await sql(`insert into app.password_credentials (user_id, phc) values ('${id}', '${phc}')`);
  }
  return id;
}
