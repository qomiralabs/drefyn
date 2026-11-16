import { expect } from '@playwright/test';
import {
  answerDocs,
  DOCS_URL,
  docsLink,
  expectSplit,
  FRAME_PAGES,
  frameBoxes,
  type FrameBoxes,
} from './auth-frame.ts';
import { uniqueAddress } from './auth-helpers.ts';
import { SELF_HOSTED } from './auth-states.ts';
import { DESKTOP, MOBILE, openShell, products, ROUTES, TABLET } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

test.describe('phone, 390 px', () => {
  test.use({ viewport: MOBILE });

  test('the sidebar and product links live in a drawer behind the menu button', async ({
    page,
  }) => {
    await openShell(page, ROUTES.project);
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
    await expect(products(page)).toBeHidden();
    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    const drawer = page.getByRole('navigation', { name: 'Payments API docs' });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('navigation', { name: 'Products, in menu' }).getByRole('link'),
    ).toHaveText([/^Docs/, /^Studio/, /^Status/]);
    await expect(drawer.getByRole('link', { name: /^Pages/ })).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(18 * 16);
  });

  test('Escape closes the drawer and returns focus to the menu button', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('the close button closes it too', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
  });

  test('nothing scrolls sideways', async ({ page }) => {
    for (const path of [ROUTES.overview, ROUTES.project, ROUTES.empty, ROUTES.error]) {
      await openShell(page, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(0);
    }
  });
});

test.describe('tablet, 834 px', () => {
  test.use({ viewport: TABLET });

  test('the sidebar is a 48 px icon rail whose links keep their names', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const rail = page.getByRole('navigation', { name: 'Payments API docs' });
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())?.width).toBe(48);
    for (const name of [
      'Home',
      'Pages',
      'Changes',
      'API reference',
      'Analytics',
      'Site settings',
    ]) {
      await expect(rail.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(rail.getByRole('link', { name: /^Home/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(products(page)).toBeVisible();
  });
});

test.describe('desktop, 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('the sidebar is 240 px and the menu button is gone', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const side = page.getByRole('navigation', { name: 'Payments API docs' });
    expect((await side.boundingBox())?.width).toBe(240);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  });

  test('the calm column is at most 45rem', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const h1 = page.getByRole('main').getByRole('heading', { level: 1 });
    expect((await h1.boundingBox())?.width).toBeLessThanOrEqual(45 * 16);
  });
});

test.describe('phone command bar', () => {
  test.use({ viewport: MOBILE, hasTouch: true });

  test('Cancel closes it by touch and focus returns to the search button', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const trigger = page
      .getByRole('banner')
      .getByRole('button', { name: /Search or run a command/ });
    await trigger.tap();
    const bar = page.getByRole('dialog', { name: 'Search or run a command' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Cancel' }).tap();
    await expect(bar).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('wide command bar', () => {
  test.use({ viewport: DESKTOP });

  test('has no Cancel button, since Escape and the scrim close it', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    await page.keyboard.press('ControlOrMeta+k');
    const bar = page.getByRole('dialog', { name: 'Search or run a command' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Cancel' })).toBeHidden();
  });
});

// The signed out frame: the form first at two fifths from 64rem, then the side panel.
test.describe('signed out frame', () => {
  test.use({ storageState: SIGNED_OUT });

  for (const width of [1280, 1024]) {
    test(`at ${String(width)} px every page splits two fifths and three fifths`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const path of FRAME_PAGES) {
        await page.goto(path);
        expectSplit(await frameBoxes(page), path);
        await expect(page.getByRole('complementary', { name: 'About Drefyn' }), path).toBeVisible();
        await expect(docsLink(page), path).toBeVisible();
      }
    });
  }

  test('sign in, verify, password and reset keep the form panel in place', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const seen: { path: string; boxes: FrameBoxes }[] = [];
    await page.goto('/sign-in');
    seen.push({ path: '/sign-in', boxes: await frameBoxes(page) });
    await page.getByLabel('Email address').fill(uniqueAddress('frame'));
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page).toHaveURL(/\/sign-in\/verify/);
    seen.push({ path: 'verify', boxes: await frameBoxes(page) });
    for (const path of ['/sign-in/password', '/sign-in/reset']) {
      await page.goto(path);
      seen.push({ path, boxes: await frameBoxes(page) });
    }
    const [first] = seen;
    for (const { path, boxes } of seen) {
      expect(boxes.main, path).toEqual(first?.boxes.main);
      expect(boxes.content, path).toEqual(first?.boxes.content);
    }
  });

  for (const width of [1023, 390]) {
    test(`at ${String(width)} px there is no side panel and the docs link is in the header`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const path of FRAME_PAGES) {
        await page.goto(path);
        const boxes = await frameBoxes(page);
        expect(boxes.side, path).toBeNull();
        expect(boxes.main.width, path).toBe(boxes.viewport);
        await expect(page.getByRole('complementary'), path).toHaveCount(0);
        const link = await docsLink(page).boundingBox();
        const head = await page.getByRole('banner').boundingBox();
        expect(link, path).not.toBeNull();
        expect(link?.y ?? -1, path).toBeGreaterThanOrEqual(head?.y ?? 0);
        expect((link?.y ?? 0) + (link?.height ?? 0), path).toBeLessThanOrEqual(
          (head?.y ?? 0) + (head?.height ?? 0),
        );
        expect((link?.x ?? 0) + (link?.width ?? 0), path).toBeLessThanOrEqual(boxes.viewport);
      }
    });
  }

  test('the Documentation link is a plain same tab link to the configured docs', async ({
    page,
  }) => {
    await answerDocs(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/sign-in');
    const link = docsLink(page);
    expect(await link.evaluate((node) => node.tagName)).toBe('A');
    await expect(link).toHaveAttribute('href', DOCS_URL);
    expect(await link.getAttribute('target')).toBeNull();
    await link.click();
    await expect(page).toHaveURL(`${DOCS_URL}/`);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('a self hosted server keeps the docs link and has no card', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(SELF_HOSTED);
      await expect(docsLink(page)).toHaveAttribute('href', DOCS_URL);
      await expect(page.getByRole('complementary')).toHaveCount(0);
      expect((await frameBoxes(page)).side).toBeNull();
    }
  });
});
