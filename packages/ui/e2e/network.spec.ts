import {
  docsIds,
  expect,
  FOUNDATIONS,
  MANAGER_READY_MS,
  openStory,
  storyIds,
  sweepTimeout,
  test,
} from './fixtures.ts';

// The fixture fails any test that asks another host for anything. These pages load the
// parts of the build a story iframe does not: the manager and a docs page. Each test waits
// for the last thing its page draws, then for every request it started to end, so a
// request made while loading is caught before the fixture checks.
test('the manager loads only from the static build', async ({ page, drained }) => {
  await page.goto(`/index.html?path=/story/${FOUNDATIONS}`);
  const sidebar = page.locator('#storybook-explorer-tree');
  await expect(
    sidebar.locator(`[data-item-id="${FOUNDATIONS}"][data-selected="true"]`),
  ).toBeVisible({ timeout: MANAGER_READY_MS });
  const story = page.frameLocator('#storybook-preview-iframe');
  await expect(story.locator('#storybook-root h1')).toBeVisible({ timeout: MANAGER_READY_MS });
  for (const frame of [page.locator('html'), story.locator('html')]) {
    await frame.evaluate(async () => {
      await document.fonts.ready;
    });
  }
  await drained();
});

test('a docs page loads only from the static build', async ({ page, drained }) => {
  const [docs] = docsIds();
  expect(docs, 'the build has at least one docs page').toBeDefined();
  await page.goto(`/iframe.html?id=${docs ?? ''}&viewMode=docs`);
  await expect(page.locator('#storybook-docs .sbdocs').first()).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await drained();
});

test('every story iframe loads only from the static build', async ({ page, drained }) => {
  const ids = storyIds();
  test.setTimeout(sweepTimeout(ids.length));
  for (const id of ids) {
    // Waits for the story, its theme and its fonts.
    await openStory(page, id, 'light');
    await drained();
  }
});

test('a malformed path gets a 404, not a stuck request', async ({ page }) => {
  const response = await page.goto('/%E0%A4%A', { waitUntil: 'commit' });
  expect(response?.status()).toBe(404);
  // Full Chrome shows its own error page for an empty 404 body.
  expect(await response?.text()).toBe('Not found');
});

// Proves the guard itself: the request is stopped before it can leave, and recorded where
// the fixture checks after every test. The record is cleared only once it has been seen.
test('a request to another host is blocked and fails the test', async ({ page, outside }) => {
  const pixel = 'https://example.com/drefyn-guard.png';
  await openStory(page, FOUNDATIONS, 'light');
  // An image, as a tracking pixel or web font would load. WebKit fires no error event on
  // the element for an aborted request, so the failure is read from Playwright instead.
  const failed = page.waitForEvent('requestfailed', (request) => request.url() === pixel);
  await page.evaluate((src) => {
    const image = new Image();
    image.src = src;
    document.body.append(image);
  }, pixel);
  await failed;
  expect(outside).toEqual([pixel]);
  outside.length = 0;
});
