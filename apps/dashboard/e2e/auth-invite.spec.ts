import { randomBytes, randomUUID } from 'node:crypto';
import { formatInvitationToken, sha256 } from '@drefyn/auth';
import { idOf } from '@drefyn/tenancy';
import { expect, type Page } from '@playwright/test';
import { organizationSql, uniqueAddress } from './auth-helpers.ts';
import { countTo, nextMail } from './mailpit.ts';
import { ACME_ID, MAYA, SAM, SIGNED_OUT, stateFile } from './people.ts';
import { test } from './test.ts';

test.use({ storageState: SIGNED_OUT });

async function invitation(email: string): Promise<string> {
  const id = randomUUID();
  const secret = randomBytes(32);
  const membership = await organizationSql(
    ACME_ID,
    `select id from app.memberships where organization_id = '${ACME_ID}' and user_id = '${MAYA.id}'`,
  );
  await organizationSql(
    ACME_ID,
    `insert into app.invitations
       (id, organization_id, email_normalized, role, invited_by, secret_hash, expires_at)
     values ('${id}', '${ACME_ID}', '${email}', 'member', '${membership}',
       decode('${sha256(secret).toString('hex')}', 'hex'), now() + interval '7 days')`,
  );
  return formatInvitationToken({
    organizationId: idOf('org', ACME_ID),
    invitationId: idOf('inv', id),
    secret,
  });
}

test('/invite/<token> is not served, and says nothing of the token', async ({ request }) => {
  const token = await invitation(uniqueAddress('path'));
  const response = await request.get(`/invite/${token}`, { maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain(token);
});

test('someone signed in as another address sees the mismatch', async ({ browser }) => {
  const token = await invitation(SAM.email.replace('sam', 'sam+other'));
  const other = await browser.newContext({ storageState: stateFile(SAM) });
  const page = await other.newPage();
  await page.goto(`/invite#${token}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'This invitation is for another address.',
  );
  await other.close();
});

test('an invited newcomer signs up by code in the same browser and lands inside', async ({
  page,
}) => {
  const address = uniqueAddress('newcomer');
  const token = await invitation(address);
  await page.goto(`/invite#${token}`);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.getByRole('link', { name: `Sign in as ${address} to join` }).click();
  await signInFromForm(page, address);
  await page.getByRole('button', { name: 'Join Acme' }).click();
  await expect(page).toHaveURL(/\/acme$/);
});

async function signInFromForm(page: Page, address: string) {
  const seen = await countTo(address);
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const { code } = await nextMail(address, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/invite/);
}

test('invite only sign up needs a live invitation for the proved address', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'This server does not take sign ups.',
  );
  const address = uniqueAddress('uninvited');
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify/);
  await page.waitForTimeout(1_000);
  expect(await countTo(address)).toBe(0);
});

test('a GET of the block link writes nothing, and only the button does', async ({
  page,
  request,
}) => {
  const token = await invitation(uniqueAddress('blocker'));
  await page.goto(`/invite#${token}`);
  const href = await page
    .getByRole('link', { name: 'I did not expect this invitation' })
    .getAttribute('href');
  if (href === null) throw new Error('no block link');
  const count = () => organizationSql(ACME_ID, 'select count(*) from app.invitation_blocks');
  const before = await count();
  await request.get(href);
  expect(await count()).toBe(before);
  await page.goto(href);
  await expect(page.getByRole('button', { name: 'Stop invitations from Acme' })).toBeVisible();
  expect(await count()).toBe(before);
  await page.getByRole('button', { name: 'Stop invitations from Acme' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Done.');
  expect(Number(await count())).toBe(Number(before) + 1);
});
