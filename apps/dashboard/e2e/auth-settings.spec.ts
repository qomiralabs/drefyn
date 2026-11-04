import { expect, type Browser, type Page } from '@playwright/test';
import {
  makeFresh,
  makeStale,
  seedPerson,
  signInByCode,
  uniqueAddress,
  userSql,
} from './auth-helpers.ts';
import { countTo, nextMail } from './mailpit.ts';
import { OMAR, RAFA, SIGNED_OUT, stateFile, TESS, type Person } from './people.ts';
import { test } from './test.ts';

// Real rows through the real pages. One organization and one inbox, so these run in order.
test.describe.configure({ mode: 'serial' });

const KEYS = '/kestrel/settings/api-keys';
const MEMBERS = '/kestrel/settings/members';
const PASSWORD = 'a harbour lantern at the end of the pier';

async function openAs(browser: Browser, person: Person, path: string): Promise<Page> {
  await makeFresh(person.id);
  const context = await browser.newContext({ storageState: stateFile(person) });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  return page;
}

async function createKey(page: Page, name: string, scope: string): Promise<string> {
  await page.getByRole('button', { name: 'Create key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an API key' });
  await dialog.getByLabel('Name').fill(name);
  // The box is drawn over a hidden input, so the press goes where a person's would.
  await dialog.getByText(scope, { exact: true }).click();
  await dialog.getByRole('button', { name: 'Create key' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your new key now' });
  const secret = (await shown.locator('[data-new-key]').textContent()) ?? '';
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toHaveCount(0);
  return secret;
}

async function signedIn(page: Page, address: string): Promise<void> {
  await signInByCode(page, address);
  await expect(page).not.toHaveURL(/\/sign-in/);
}

// A new person who owns a new organization, signed in by code, so their session is their own
// to rotate and no other test leans on it.
async function freshOwner(
  page: Page,
  password?: string,
): Promise<{ id: string; address: string; slug: string }> {
  const address = uniqueAddress('settings');
  const id = await seedPerson(address, password);
  await signedIn(page, address);
  await page.goto('/organizations/new');
  const name = `Team ${id.slice(-6)}`;
  const slug = `team-${id.slice(-6)}`;
  // Typing before hydration is lost, and the address filling in proves it was not.
  await expect(async () => {
    await page.getByLabel('Name').fill(name);
    await expect(page.getByLabel('Address')).toHaveValue(slug, { timeout: 500 });
  }).toPass();
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}$`));
  return { id, address, slug };
}

test('an API key is shown once, works over HTTP, and is gone on reload', async ({
  browser,
  request,
}) => {
  const page = await openAs(browser, OMAR, KEYS);
  const secret = await createKey(page, 'shown-once', 'Read pages');
  expect(secret).toMatch(/^drf_ak_/);
  const answer = await request.get('/settings-states/whoami', {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(answer.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('cell', { name: /^shown-once/ })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
  await page.context().close();
});

test('each key filter narrows the list, in the URL', async ({ browser }) => {
  const page = await openAs(browser, OMAR, KEYS);
  await createKey(page, 'filter-status', 'Write incidents');
  const rows = page.getByRole('table').getByRole('row');
  await page.getByRole('searchbox', { name: 'Search keys by name' }).fill('filter-status');
  await expect(page).toHaveURL(/q=filter-status/);
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /^Can/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Status' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/can=status/);
  await expect(page.getByRole('cell', { name: /^shown-once/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /^Last used/ }).click();
  await page.getByRole('menuitemradio', { name: 'Never used' }).click();
  await expect(page).toHaveURL(/used=never/);
  await expect(page.getByRole('cell', { name: /^filter-status/ })).toBeVisible();
  await page.goto(`${KEYS}?used=7d`);
  await expect(page.getByRole('cell', { name: /^filter-status/ })).toHaveCount(0);
  await page.context().close();
});

test('removal lists the keys first, and they stay listed as revoked with no action', async ({
  browser,
}) => {
  const admin = await openAs(browser, TESS, KEYS);
  await createKey(admin, 'tess-deploy', 'Read pages');
  await admin.context().close();

  const page = await openAs(browser, OMAR, MEMBERS);
  await page.getByRole('button', { name: `Remove ${TESS.name}` }).click();
  const dialog = page.getByRole('dialog', { name: /^Remove Tess Moore/ });
  await expect(dialog.getByRole('list', { name: 'Keys that will be revoked' })).toContainText(
    'tess-deploy',
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Remove Tess and revoke 1 key' }).click();
  await expect(page.getByRole('cell', { name: /Tess Moore/ })).toHaveCount(0);

  await page.goto(`${KEYS}?by=former`);
  const row = page.getByRole('row', { name: /^tess-deploy/ });
  await expect(row).toContainText('Revoked');
  await expect(row.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  await page.context().close();
});

test('a retried revoke shows no error', async ({ browser }) => {
  const first = await openAs(browser, OMAR, KEYS);
  await createKey(first, 'revoke-twice', 'Read pages');
  const second = await first.context().newPage();
  await second.goto(KEYS);
  await expect(second.locator('html')).toHaveAttribute('data-shell', 'ready');
  for (const page of [first, second]) {
    await page.getByRole('button', { name: 'Revoke revoke-twice' }).click();
  }
  for (const page of [first, second]) {
    await page.bringToFront();
    await page
      .getByRole('dialog', { name: 'Revoke revoke-twice?' })
      .getByRole('button', { name: 'Revoke key' })
      .click();
    await expect(page.getByText('revoke-twice is revoked.')).toBeVisible();
  }
  await expect(second.getByText('Could not')).toHaveCount(0);
  await first.context().close();
});

test('a member sees no controls for people or keys', async ({ browser }) => {
  const page = await openAs(browser, RAFA, MEMBERS);
  await expect(page.getByText('Only owners and admins can invite people')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Role for/ })).toHaveCount(0);
  await page.goto(KEYS);
  await expect(page.getByText('Only owners and admins can create or revoke keys.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Revoke/ })).toHaveCount(0);
  await page.context().close();
});

test('an invitation can be sent and withdrawn, and Undo sends it again', async ({ browser }) => {
  const page = await openAs(browser, OMAR, MEMBERS);
  const address = uniqueAddress('invited');
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: /^Invite people/ });
  await dialog.getByRole('textbox', { name: /Email addresses/ }).fill(address);
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Send 1 invitation' }).click();
  await expect(page.getByRole('cell', { name: address, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Withdraw invitation to ${address}` }).click();
  await expect(page.getByRole('cell', { name: address, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('cell', { name: address, exact: true })).toBeVisible();
  await page.context().close();
});

test('a stale session is asked to confirm, by password, and the action then runs', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = await context.newPage();
  const { id } = await freshOwner(page, PASSWORD);
  await page.goto('/account/sign-in');
  await makeStale(id);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Remove your password?' })
    .getByRole('button', { name: 'Remove password' })
    .click();
  const prompt = page.getByRole('dialog', { name: 'Confirm it is you' });
  await prompt.getByLabel('Your password').fill('not the password at all, sorry');
  await prompt.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(prompt.getByText('That password is not right.')).toBeVisible();
  await prompt.getByLabel('Your password').fill(PASSWORD);
  await prompt.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(prompt).toHaveCount(0);
  // After a removal the page offers to end every other session.
  await expect(page.getByRole('status').filter({ hasText: 'Password removed.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toBeVisible();
  await context.close();
});

test('with no password the prompt mails a code, and creating the key then runs', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = await context.newPage();
  const { id, address, slug } = await freshOwner(page);
  await page.goto(`/${slug}/settings/api-keys`);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await makeStale(id);
  const seen = await countTo(address);
  await page.getByRole('button', { name: 'Create key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an API key' });
  await dialog.getByLabel('Name').fill('after-step-up');
  await dialog.getByText('Read pages', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Create key' }).click();
  const prompt = page.getByRole('dialog', { name: 'Confirm it is you' });
  const { code } = await nextMail(address, seen);
  await prompt.getByLabel(/Code sent to/).fill(code);
  await prompt.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByRole('dialog', { name: 'Copy your new key now' })).toBeVisible();
  await context.close();
});

test('sign out everywhere else takes effect on the next request elsewhere', async ({ browser }) => {
  const here = await browser.newContext({ storageState: SIGNED_OUT });
  const elsewhere = await browser.newContext({ storageState: SIGNED_OUT });
  const page = await here.newPage();
  const other = await elsewhere.newPage();
  const { address } = await freshOwner(page);
  await signedIn(other, address);
  await other.goto('/account/sessions');
  await expect(other.locator('html')).toHaveAttribute('data-shell', 'ready');
  await page.goto('/account/sessions');
  await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
  await page.getByRole('button', { name: 'Sign out 1 session' }).click();
  await expect(page.getByText('Signed out 1 other session.')).toBeVisible();
  await other.reload();
  await expect(other).toHaveURL(/\/sign-in/);
  await page.reload();
  await expect(page).toHaveURL(/\/account\/sessions/);
  await here.close();
  await elsewhere.close();
});

test('changing the address needs a code and tells the old one', async ({ browser }) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = await context.newPage();
  const { address, id } = await freshOwner(page);
  await page.goto('/account');
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  const next = uniqueAddress('moved');
  const seen = await countTo(next);
  const oldSeen = await countTo(address);
  await page.getByRole('button', { name: 'Change email' }).click();
  await page.getByLabel('New address').fill(next);
  await page.getByRole('button', { name: 'Send code' }).click();
  const { code } = await nextMail(next, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Change address' }).click();
  await expect(page.getByText(`Your address is now ${next}.`)).toBeVisible();
  await expect.poll(() => countTo(address)).toBeGreaterThan(oldSeen);
  expect(await userSql(id, 'select email from app.users')).toContain(next);
  await context.close();
});
