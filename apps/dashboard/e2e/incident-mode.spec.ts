import { expect } from '@playwright/test';
import { addField, focused, main, MOBILE, notifications, openShell } from './fixtures.ts';
import {
  barWidth,
  COCKPIT,
  COCKPIT_MARK,
  DOCS_PAGES,
  heading,
  incidentOpen,
  line,
  openCockpit,
  said,
  sidebar,
  startFromCommandBar,
  STATUS,
} from './incident-helpers.ts';
import { test } from './csp.ts';

const WIDE = { width: 1440, height: 900 };
const NAV = 240;
const RAIL = 48;

// Runs in the shell-chromium and reduced-motion projects, which differ only in this setting.
test.describe('entering incident mode', () => {
  test.use({ viewport: WIDE });

  test('moves focus to the heading, announces it and steps the sidebar back', async ({ page }) => {
    await openShell(page, STATUS);
    expect(await barWidth(page)).toBe(NAV);
    await startFromCommandBar(page);
    await expect(page).toHaveURL(COCKPIT);
    await expect(heading(page)).toBeFocused();
    await expect(said(page, 'assertive')).toHaveText(
      'Incident mode. Payments API is failing in Europe.',
    );
    await expect(line(page)).toContainText('You are in incident mode.');
    expect(await barWidth(page)).toBe(RAIL);
    await expect(sidebar(page).getByRole('link', { name: 'Incidents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('shows what a person needs, and publishes nothing by itself', async ({ page }) => {
    await openCockpit(page);
    const body = main(page);
    await expect(body.getByRole('heading', { name: 'Affected' })).toBeVisible();
    await expect(body.getByRole('heading', { name: COCKPIT_MARK })).toBeVisible();
    await expect(body.getByRole('heading', { name: 'Reach' })).toBeVisible();
    await expect(body.getByRole('table', { name: /probe region/i }).getByRole('row')).toHaveCount(
      7,
    );
    await expect(body.getByRole('textbox', { name: 'Draft update' })).toBeVisible();
    await expect(body.getByText('Nothing is published until you approve it.')).toBeVisible();
    await body.getByRole('button', { name: 'Publish update' }).click();
    await expect(notifications(page).getByText('Publishing is not available yet.')).toBeVisible();
  });

  test('glides in with normal motion and only fades under reduced motion', async ({ page }) => {
    await openShell(page, STATUS);
    const reduced = await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    await page.evaluate(() => {
      const frames: { opacity: number; moved: boolean }[] = [];
      (window as unknown as { frames_: typeof frames }).frames_ = frames;
      const started = performance.now();
      const look = () => {
        const el = document.querySelector('[data-cockpit]');
        if (el !== null) {
          const style = getComputedStyle(el);
          frames.push({
            opacity: Number(style.opacity),
            moved: style.transform !== 'none' && style.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
          });
        }
        if (performance.now() - started < 4000) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await startFromCommandBar(page);
    await expect(heading(page)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { frames_ } = window as unknown as { frames_: { opacity: number }[] };
          return frames_.at(-1)?.opacity;
        }),
      )
      .toBe(1);
    await page.waitForTimeout(400);
    const frames = await page.evaluate(
      () => (window as unknown as { frames_: { opacity: number; moved: boolean }[] }).frames_,
    );
    expect(frames.some((f) => f.opacity < 1)).toBe(true);
    expect(frames.some((f) => f.moved)).toBe(!reduced);
    expect(frames.at(-1)).toEqual({ opacity: 1, moved: false });
    // The way in leaves the page no wider than the window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(WIDE.width);
  });

  test('from the line keeps the path back to where the person was', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, DOCS_PAGES);
    await line(page).getByRole('link', { name: 'Open incident' }).click();
    await expect(heading(page)).toBeFocused();
    await line(page).getByRole('link', { name: 'Back to calm view' }).click();
    await expect(page).toHaveURL(DOCS_PAGES);
  });

  test('works from a page under another layout, and resolves back to it', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, '/account');
    await line(page).getByRole('link', { name: 'Open incident' }).click();
    await expect(heading(page)).toBeFocused();
    await expect(said(page, 'assertive')).toHaveText(
      'Incident mode. Payments API is failing in Europe.',
    );
    await main(page).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(page).toHaveURL('/account');
    await expect(
      notifications(page).getByText('Incident resolved at 14:51 UTC. Back to the calm view.'),
    ).toBeVisible();
    await expect(main(page).getByRole('heading', { level: 1 })).toBeFocused();
  });

  test('does not take focus or announce when the page is simply opened', async ({ page }) => {
    await openCockpit(page);
    expect(await focused(page)).toBe('body');
    await expect(said(page, 'assertive')).toHaveText('');
    await page.reload();
    await expect(heading(page)).toBeVisible();
    expect(await barWidth(page)).toBe(RAIL);
  });

  test('an incident URL with nothing open says so', async ({ page }) => {
    await openShell(page, COCKPIT);
    await expect(main(page).getByRole('heading', { name: /not open/ })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    expect(await barWidth(page)).toBe(NAV);
  });

  test('a cockpit that fails to load says so and works on the next try', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, DOCS_PAGES);
    let refusing = true;
    await page.route('**/_next/static/**/*.js', async (route) => {
      const response = await route.fetch();
      if (refusing && (await response.text()).includes(COCKPIT_MARK)) await route.abort();
      else await route.fulfill({ response });
    });
    await line(page).getByRole('link', { name: 'Open incident' }).click();
    const failed = main(page).getByRole('heading', { name: /could not open this incident/ });
    await expect(failed).toBeVisible();
    refusing = false;
    await main(page).getByRole('button', { name: 'Try again' }).click();
    await expect(heading(page)).toBeFocused();
  });
});

test.describe('leaving incident mode', () => {
  test.use({ viewport: WIDE });

  test('Back to calm view keeps focus on the link and the incident open', async ({ page }) => {
    await openShell(page, STATUS);
    await startFromCommandBar(page);
    await expect(heading(page)).toBeFocused();
    const link = line(page).getByRole('link', { name: 'Back to calm view' });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(STATUS);
    await expect(line(page).getByRole('link', { name: 'Open incident' })).toBeFocused();
    await expect(said(page, 'polite')).toHaveText(
      'Back to the calm view. The incident is still open.',
    );
    await expect(line(page)).toContainText('A draft update is waiting for you.');
    expect(await barWidth(page)).toBe(NAV);
  });

  test('the browser back button returns to calm the same way', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, STATUS);
    await line(page).getByRole('link', { name: 'Open incident' }).click();
    await expect(heading(page)).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(STATUS);
    await expect(line(page).getByRole('link', { name: 'Open incident' })).toBeFocused();
    expect(await barWidth(page)).toBe(NAV);
  });

  test('resolving returns to calm and restores the element that had focus', async ({ page }) => {
    await openShell(page, STATUS);
    const inbox = page.getByRole('banner').getByRole('button', { name: /inbox/i });
    await inbox.focus();
    await startFromCommandBar(page);
    await expect(heading(page)).toBeFocused();
    await main(page).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(page).toHaveURL(STATUS);
    await expect(inbox).toBeFocused();
    await expect(
      notifications(page).getByText('Incident resolved at 14:51 UTC. Back to the calm view.'),
    ).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    expect(await barWidth(page)).toBe(NAV);
    await expect(main(page).getByRole('heading', { level: 1 })).toContainText('No monitors yet.');
  });

  test('falls back to the page heading when that element is gone', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, STATUS);
    // The line leaves with the incident, so the link that opened it cannot take focus back.
    await line(page).getByRole('link', { name: 'Open incident' }).click();
    await expect(heading(page)).toBeFocused();
    await main(page).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(main(page).getByRole('heading', { level: 1 })).toBeFocused();
    await expect(main(page).getByRole('heading', { level: 1 })).toContainText('No monitors yet.');
  });

  test('the calm page settles in, and travels only with normal motion', async ({ page }) => {
    await openCockpit(page);
    const reduced = await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    await main(page).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(page).toHaveURL(STATUS);
    const distance = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--dr-distance-enter').trim(),
    );
    expect(distance).toBe(reduced ? '0px' : '4px');
  });
});

test.describe('an incident that opens elsewhere', () => {
  test.use({ viewport: WIDE });

  test('is said once, and moves nothing under the person', async ({ page, context }) => {
    await openShell(page, DOCS_PAGES);
    const field = await addField(page);
    await field.focus();
    const other = await context.newPage();
    await openShell(other, STATUS);
    await startFromCommandBar(other);
    await expect(heading(other)).toBeFocused();

    await expect(line(page)).toContainText('A draft update is waiting for you.');
    await expect(said(page, 'polite')).toHaveText(
      'Incident opened: Payments API, partial outage in Europe',
    );
    await expect(said(page, 'assertive')).toHaveText('');
    await expect(field).toBeFocused();
    await expect(page).toHaveURL(DOCS_PAGES);
    expect(await barWidth(page)).toBe(NAV);

    await main(other).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(line(page)).toHaveCount(0);
    await expect(
      notifications(page).getByText('Incident resolved at 14:51 UTC. Back to the calm view.'),
    ).toBeVisible();
    await expect(field).toBeFocused();
    await other.close();
  });

  test('resolved from another tab brings the cockpit back to calm', async ({ page, context }) => {
    await openShell(page, STATUS);
    await startFromCommandBar(page);
    await expect(heading(page)).toBeFocused();
    const other = await context.newPage();
    await openShell(other, COCKPIT);
    await main(other).getByRole('button', { name: 'Resolve incident' }).click();
    await expect(page).toHaveURL(STATUS);
    await expect(main(page).getByRole('heading', { level: 1 })).toContainText('No monitors yet.');
    await other.close();
  });
});

test.describe('at 390 px', () => {
  test.use({ viewport: MOBILE });

  test('one column, draft first, and nothing runs off the side', async ({ page }) => {
    await openCockpit(page);
    const top = (name: string) =>
      main(page)
        .getByRole('heading', { name })
        .evaluate((el) => el.getBoundingClientRect().top);
    expect(await top(COCKPIT_MARK)).toBeLessThan(await top('Affected'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(MOBILE.width);
    await expect(line(page).getByRole('link', { name: 'Back to calm view' })).toBeVisible();
  });

  test('the line sits under the drawer with everything else', async ({ page }) => {
    await incidentOpen(page);
    await openShell(page, STATUS);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('[data-incident-line]')).toHaveJSProperty('inert', true);
  });
});
