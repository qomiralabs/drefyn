import { expect, test, type Page } from '@playwright/test';
import {
  ANSWERS,
  banner,
  commandBar,
  NEEDS_YOU,
  main,
  openShell,
  products,
  ROUTES,
  THEMES,
  useTheme,
} from './fixtures.ts';
import { expectBodyLeaksNothing, expectTitleLeaksNothing, UNKNOWN_ORG_PATHS } from './leaks.ts';

test.describe('flag on', () => {
  test('/ sends a first visit to the organization overview', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/acme$/);
  });

  for (const [path, status] of [
    ['/nobody', 404],
    ['/acme/blog', 404],
    ['/acme/docs/missing', 404],
    ['/Acme', 404],
  ] as const) {
    test(`${path} is ${status}`, async ({ request }) => {
      expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(status);
    });
  }

  for (const path of UNKNOWN_ORG_PATHS) {
    test(`${path} is a 404 that sends no page content and no page title`, async ({
      request,
      page,
    }) => {
      await expectBodyLeaksNothing(request, path);
      await expectTitleLeaksNothing(page, path);
    });
  }

  test('every shell route answers 200', async ({ request }) => {
    for (const path of [ROUTES.overview, ROUTES.project, ROUTES.empty]) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });
});

test.describe('landmarks', () => {
  test('one banner, a Products navigation inside it, a named sidebar and one main', async ({
    page,
  }) => {
    await openShell(page, ROUTES.project);
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(products(page)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(main(page)).toHaveAttribute('id', 'main');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('the overview sidebar is named for the organization', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const side = page.getByRole('navigation', { name: 'Acme', exact: true });
    await expect(side).toBeVisible();
    await expect(side.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the skip link is first and lands on main', async ({ page, browserName }) => {
    await openShell(page, ROUTES.project);
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(main(page)).toBeFocused();
  });
});

test.describe('top bar', () => {
  test('the mark goes to the organization overview', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await expect(banner(page).getByRole('link', { name: 'Acme overview' })).toHaveAttribute(
      'href',
      '/acme',
    );
  });

  test('product links use the short names, keep the organization and mark the current one', async ({
    page,
  }) => {
    await openShell(page, ROUTES.project);
    const links = products(page).getByRole('link');
    await expect(links).toHaveText([/^Docs/, /^Studio/, /^Status/]);
    await expect(products(page).getByRole('link', { name: /^Docs/ })).toHaveAttribute(
      'href',
      '/acme/docs',
    );
    await expect(products(page).getByRole('link', { name: /^Studio/ })).toHaveAttribute(
      'href',
      '/acme/studio',
    );
    await expect(products(page).getByRole('link', { name: /^Status/ })).toHaveAttribute(
      'href',
      '/acme/status',
    );
    await expect(products(page).getByRole('link', { name: /^Docs/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(products(page).locator('[aria-current]')).toHaveCount(1);
  });

  test('the current product is marked by more than colour', async ({ page }) => {
    await openShell(page, ROUTES.project);
    // Weight and a visible bar, both absent on the other links.
    const cues = (name: RegExp) =>
      products(page)
        .getByRole('link', { name })
        .evaluate((el) => {
          const visible = (color: string) => !/^(transparent|rgba\(.*,\s*0\))$/.test(color);
          const s = getComputedStyle(el);
          const pseudo = ['::before', '::after'].map((p) => getComputedStyle(el, p));
          const bar =
            (parseFloat(s.borderBottomWidth) > 0 && visible(s.borderBottomColor)) ||
            s.boxShadow !== 'none' ||
            pseudo.some(
              (p) => p.content !== 'none' && parseFloat(p.height) > 0 && visible(p.backgroundColor),
            );
          return { weight: s.fontWeight, bar };
        });
    const current = await cues(/^Docs/);
    const other = await cues(/^Studio/);
    expect(current.weight).not.toBe(other.weight);
    expect(current.bar).toBe(true);
    expect(other.bar).toBe(false);
  });

  test('no product is current on the overview', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    await expect(products(page).locator('[aria-current]')).toHaveCount(0);
  });

  test('the command bar entry says what it does and its keys', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const trigger = banner(page).getByRole('button', { name: 'Search or run a command' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  });

  for (const theme of THEMES) {
    test(`the inbox count is a plain number, never a state colour (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await openShell(page, ROUTES.overview);
      const inbox = banner(page).getByRole('button', { name: `Inbox, ${NEEDS_YOU} need you` });
      await expect(inbox).toBeVisible();
      const count = inbox.getByText(String(NEEDS_YOU), { exact: true });
      await expect(count).toBeVisible();
      const { paints, states } = await count.evaluate((el) => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (value: string) => {
          probe.style.color = value;
          return getComputedStyle(probe).color;
        };
        const names = ['fresh', 'stale', 'broken'].flatMap((s) =>
          [`mark`, `text`].map((k) => `--dr-state-${s}-${k}`),
        );
        const states = names.map((n) => resolve(root.getPropertyValue(n).trim()));
        probe.remove();
        const s = getComputedStyle(el);
        return { paints: [s.color, s.backgroundColor], states };
      });
      for (const paint of paints) expect(states).not.toContain(paint);
    });
  }

  test('the account button reads its initials first, then whose account', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const account = banner(page).getByRole('button', { name: 'MO, account for Maya Okafor' });
    await expect(account).toBeVisible();
    await account.click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    // A MenuSection titled Theme; the items are menuitem today, menuitemradio once Menu
    // takes a selection mode.
    const theme = menu.getByRole('group', { name: 'Theme' });
    await expect(theme.getByRole('menuitem').or(theme.getByRole('menuitemradio'))).toHaveText([
      'System',
      'Light',
      'Dark',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  test('the organization menu lists the organization and its settings', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    await banner(page).getByRole('button', { name: /^Acme/ }).click();
    const menu = page.getByRole('menu', { name: 'Organization' });
    await expect(menu).toBeVisible();
    for (const item of [
      'Plan and usage',
      'Members',
      'Organization settings',
      'Create organization',
    ]) {
      await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible();
    }
  });
});

test.describe('sidebar and URL', () => {
  test('lists the project sections as links under /:org/:product/:project', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const side = page.getByRole('navigation', { name: 'Payments API docs' });
    const sections = side.getByRole('list').first().getByRole('link');
    await expect(sections).toHaveText([
      /^Home/,
      /^Pages/,
      /^Changes/,
      /^API reference/,
      /^Analytics/,
      /^Site settings/,
    ]);
    await expect(side.getByRole('link', { name: /^Home/ })).toHaveAttribute('href', ROUTES.project);
    await expect(side.getByRole('link', { name: /^Home/ })).toHaveAttribute('aria-current', 'page');
    for (const href of await sections.evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')),
    )) {
      expect(href).toMatch(/^\/acme\/docs\/payments-api(\/[a-z-]+)?$/);
    }
  });

  test('the sidebar ends with Plan and usage and Organization settings', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const side = page.getByRole('navigation', { name: 'Payments API docs' });
    await expect(side.getByRole('link', { name: /^Plan and usage/ })).toBeVisible();
    await expect(side.getByRole('link', { name: /^Organization settings/ })).toBeVisible();
  });

  test('the product link from a project keeps the organization', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await products(page)
      .getByRole('link', { name: /^Status/ })
      .click();
    await expect(page).toHaveURL(/\/acme\/status(\/[a-z0-9-]+)?$/);
    await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('answers', () => {
  test('the inbox, the overview sentence and the Needs you list agree on what needs you', async ({
    page,
  }) => {
    await openShell(page, ROUTES.overview);
    const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const heading = await main(page).getByRole('heading', { level: 1 }).textContent();
    const said = /^(\w+) things? needs? you\./.exec(heading ?? '')?.[1] ?? '';
    const inbox = await banner(page)
      .getByRole('button', { name: /^Inbox, / })
      .getAttribute('aria-label');
    const counted = Number(/^Inbox, (\d+) need you$/.exec(inbox ?? '')?.[1]);
    const listed = await main(page)
      .getByRole('region', { name: 'Needs you' })
      .getByRole('listitem')
      .count();
    expect({ said: words.indexOf(said), counted, listed }).toEqual({
      said: NEEDS_YOU,
      counted: NEEDS_YOU,
      listed: NEEDS_YOU,
    });
  });

  test('the overview heading is the answer sentence', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(ANSWERS.overview);
  });

  test('the project home heading answers whether the site is fresh', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(ANSWERS.project);
  });

  test('the page title names the place', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await expect(page).toHaveTitle(/Payments API docs/);
  });
});

test.describe('JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('the overview renders its sentence, sidebar links and product links', async ({ page }) => {
    await page.goto(ROUTES.overview);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ANSWERS.overview);
    await expect(products(page).getByRole('link')).toHaveCount(3);
    await expect(
      page.getByRole('navigation', { name: 'Acme', exact: true }).getByRole('link').first(),
    ).toBeVisible();
  });
});

test.describe('command bar content', () => {
  const open = async (page: Page) => {
    await openShell(page, ROUTES.overview);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(commandBar(page)).toBeVisible();
    return commandBar(page);
  };

  test('says where it searches and how to drive it, in mono keycaps', async ({ page }) => {
    const bar = await open(page);
    await expect(bar.getByText('In Acme', { exact: true })).toBeVisible();
    const keys = bar.locator('kbd');
    await expect(keys.filter({ hasText: 'Enter' })).toBeVisible();
    await expect(keys.filter({ hasText: 'esc' })).toBeVisible();
    const family = await keys.first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/JetBrains Mono/);
  });

  test('rows carry a kind icon, and objects their state word', async ({ page }) => {
    const bar = await open(page);
    const options = bar.getByRole('option');
    for (const option of await options.all()) {
      await expect(option.locator(':scope > svg[data-icon]')).toHaveCount(1);
    }
    await expect(options.filter({ hasText: 'Payments API docs, Docs project' })).toContainText(
      'Out of date',
    );
    await expect(options.filter({ hasText: 'Acme status' })).toContainText('Running');
  });

  test('the active row is filled, and the focus ring stays on the field', async ({ page }) => {
    const bar = await open(page);
    await page.keyboard.press('ArrowDown');
    const active = bar.locator('[role="option"][data-focused]');
    await expect(active).toHaveCount(1);
    const { background, outline } = await active.evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, outline: s.outlineStyle };
    });
    expect(background).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    expect(outline).toBe('none');
  });

  test('finds places by their keywords', async ({ page }) => {
    const bar = await open(page);
    await page.keyboard.type('billing');
    await expect(bar.getByRole('option')).toHaveText([/^Plan and usage/]);
  });

  test('the clear button is the brand close icon and empties the field', async ({ page }) => {
    const bar = await open(page);
    await page.keyboard.type('pay');
    const clear = bar.getByRole('button', { name: 'Clear search' });
    await expect(clear.locator('svg[data-icon="close"]')).toHaveCount(1);
    await clear.click();
    await expect(bar.getByRole('combobox')).toHaveValue('');
  });

  test('no results says so in plain text, with nothing to tab to in the list', async ({ page }) => {
    const bar = await open(page);
    await page.keyboard.type('zzzz');
    await expect(bar.getByText('Nothing matches “zzzz”.')).toBeVisible();
    await expect(bar.getByRole('link')).toHaveCount(0);
  });

  test('a status line announces no results and is empty otherwise', async ({ page }) => {
    const bar = await open(page);
    const status = bar.locator('[role="status"]');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText('');
    await page.keyboard.type('pay');
    await expect(bar.getByRole('option').first()).toBeVisible();
    await expect(status).toHaveText('');
    await page.keyboard.type('zzzz');
    await expect(status).toHaveText('No results for “payzzzz”');
    await expect(status.locator('xpath=ancestor::*[@role="listbox"]')).toHaveCount(0);
    await bar.getByRole('button', { name: 'Clear search' }).click();
    await expect(status).toHaveText('');
  });
});
