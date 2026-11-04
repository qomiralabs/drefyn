import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ON_ORIGIN } from './fixtures.ts';
import { MAYA, SIGNED_OUT } from './people.ts';
import { serverEnv } from './stack-env.ts';
import { test } from './test.ts';

test.use({ storageState: SIGNED_OUT });

const cli = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url));

function printedLink(): string {
  const result = spawnSync(process.execPath, [cli, 'auth', 'link', '--email', MAYA.email], {
    env: { ...process.env, ...serverEnv(ON_ORIGIN) },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`drefyn auth link exited ${String(result.status)}`);
  return result.stdout.trim();
}

test('a printed link signs in once, and the second open is invalid', async ({ page, browser }) => {
  const link = new URL(printedLink());
  await page.goto(link.pathname + link.hash);
  await expect(page).toHaveURL(/\/acme$/);
  const again = await browser.newContext({ storageState: SIGNED_OUT });
  const second = await again.newPage();
  await second.goto(link.pathname + link.hash);
  await expect(second.getByRole('heading', { level: 1 })).toContainText(
    'This sign in link no longer works.',
  );
  await again.close();
});

test('a malformed link reads the same as a used one', async ({ page }) => {
  await page.goto('/sign-in/cli#drf_cl_nonsense');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'This sign in link no longer works.',
  );
});
