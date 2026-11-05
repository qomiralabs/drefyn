import { expect } from '@playwright/test';
import { uniqueAddress } from './auth-helpers.ts';
import { OAUTH_ORIGIN } from './oauth-fake.ts';
import { hasSession, newAccount, PROVIDERS, signInThrough, test } from './oauth-helpers.ts';
import { SIGNED_OUT } from './people.ts';

// Runs in the auth-no-js project: the provider buttons are plain links, so this has to work.
test.use({ baseURL: OAUTH_ORIGIN, storageState: SIGNED_OUT });

for (const each of PROVIDERS) {
  test(`${each.label} sign in works with scripts off`, async ({ page, provider }) => {
    const account = newAccount(uniqueAddress(`oauth-nojs-${each.name}`));
    await signInThrough(page, provider, each, { account });
    await expect(page).toHaveURL(/\/welcome$/);
    expect(await hasSession(page)).toBe(true);
  });
}
