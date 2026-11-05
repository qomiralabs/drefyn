import { expect } from '@playwright/test';
import { COCKPIT, STATUS } from './incident-helpers.ts';
import { test } from './test.ts';

// With the flag off incident mode is gone with the rest of the shell.

for (const path of [COCKPIT, `${STATUS}/incidents/new`]) {
  test(`${path} is a 404`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
  });
}
