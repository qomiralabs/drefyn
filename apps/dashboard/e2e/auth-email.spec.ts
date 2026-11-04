import { expect } from '@playwright/test';
import { askForCode, signInByCode, uniqueAddress } from './auth-helpers.ts';
import { nextMail, countTo } from './mailpit.ts';
import { MAYA, SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

test.use({ storageState: SIGNED_OUT });

test('request, receive, verify, land signed in, sign out', async ({ page }) => {
  await signInByCode(page, MAYA.email);
  await expect(page).toHaveURL(/\/acme$/);
  await page.getByRole('button', { name: /^MO/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto('/acme');
  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test('the link in the mail offers Continue as, then signs in', async ({ page }) => {
  const seen = await countTo(MAYA.email);
  await askForCode(page, MAYA.email);
  const { link } = await nextMail(MAYA.email, seen);
  await page.goto(new URL(link).pathname + new URL(link).hash);
  await page.getByRole('button', { name: `Continue as ${MAYA.email}` }).click();
  await expect(page).toHaveURL(/\/acme$/);
});

test('Continue as appears only with the matching binding cookie', async ({ page, browser }) => {
  const seen = await countTo(MAYA.email);
  await askForCode(page, MAYA.email);
  const { code, link } = await nextMail(MAYA.email, seen);
  const other = await browser.newContext({ storageState: SIGNED_OUT });
  const elsewhere = await other.newPage();
  await elsewhere.goto(new URL(link).pathname + new URL(link).hash);
  await expect(elsewhere.getByRole('heading', { level: 1 })).toContainText(
    'Type this code where you asked.',
  );
  await expect(elsewhere.getByRole('button', { name: /Continue as/ })).toHaveCount(0);
  await expect(elsewhere.getByText(MAYA.email)).toHaveCount(0);
  await expect(elsewhere.getByRole('img', { name: /^Code:/ })).toHaveAccessibleName(
    `Code: ${code.split('').join(' ')}`,
  );
  await other.close();
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/acme$/);
});

test('every step reads the same for a known and an unknown address', async ({ browser }) => {
  const bodies: string[] = [];
  const unknown = uniqueAddress('nobody');
  for (const address of [MAYA.email, unknown]) {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    await askForCode(page, address);
    const text = await page.getByRole('main').innerText();
    bodies.push(text.replaceAll(address, '<address>'));
    await context.close();
  }
  expect(bodies[0]).toBe(bodies[1]);
});
