import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
import {
  banner,
  commandBar,
  notifications,
  openShell,
  ROUTES,
  routeCommandBar,
} from './fixtures.ts';

// Watches for the dialog in the first animation frame after the press, so "at once" means
// the next paint, not whenever the test runner looks.
async function watchFirstFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { firstFrame?: boolean };
    const onKey = (event: KeyboardEvent) => {
      // The modifier goes down first; only the K counts.
      if (event.key.toLowerCase() !== 'k') return;
      window.removeEventListener('keydown', onKey);
      requestAnimationFrame(() => {
        w.firstFrame =
          document.querySelector('[role="dialog"][aria-label="Search or run a command"]') !== null;
      });
    };
    window.addEventListener('keydown', onKey);
  });
}

const firstFrame = (page: Page) =>
  page.evaluate(() => (window as unknown as { firstFrame?: boolean }).firstFrame);

test('the first press shows the frame in the next frame, before the code arrives', async ({
  page,
}) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  await watchFirstFrame(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect.poll(() => firstFrame(page)).toBe(true);
  await expect(commandBar(page)).toBeVisible();
  // The field takes typing at once; nothing waits for the chunk.
  const field = commandBar(page).getByRole('textbox', { name: 'Search or run a command' });
  await expect(field).toBeFocused();
  await expect.poll(chunk.requested, { message: 'the chunk was asked for' }).toBeGreaterThan(0);
  // Still held, and the frame still stands on its own.
  await expect(commandBar(page).getByRole('combobox')).toHaveCount(0);
  chunk.release();
  await expect(commandBar(page).getByRole('combobox')).toBeFocused();
});

test('a slow chunk shows skeleton rows after the reveal wait, never a spinner', async ({
  page,
}) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  await page.keyboard.press('ControlOrMeta+k');
  const rows = commandBar(page).locator('[data-pending-rows]');
  const row = rows.locator(':scope > span').first();
  // Held out of sight for the reveal wait, so a quick load never flashes them, then shown.
  expect(
    await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.animationName, s.animationDelay];
    }),
  ).toEqual(['dr-reveal', '0.2s']);
  await expect(row).toBeVisible();
  await expect(commandBar(page).locator('[aria-busy="true"]')).toHaveCount(1);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(commandBar(page).getByRole('status')).toHaveText('Loading search');
  await page.keyboard.type('pay');
  chunk.release();
  // The results take over with what was typed, and the caret stays at its end.
  const combobox = commandBar(page).getByRole('combobox');
  await expect(combobox).toBeFocused();
  await expect(combobox).toHaveValue('pay');
  // The first row is lit, as typing it here would have done, so Enter runs it.
  await expect(commandBar(page).getByRole('option').first()).toHaveAttribute(
    'data-focused',
    'true',
  );
  await expect(rows).toHaveCount(0);
  await page.keyboard.type('m');
  await expect(combobox).toHaveValue('paym');
});

test('text typed while the code loads runs with Enter once the results land', async ({ page }) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('Payments API docs');
  chunk.release();
  const options = commandBar(page).getByRole('option');
  await expect(options.first()).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(commandBar(page)).toBeHidden();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^${ROUTES.project}`));
});

test('Escape closes the frame while the code loads, and focus goes back', async ({ page }) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  const trigger = banner(page).getByRole('button', { name: /Search or run a command/ });
  await trigger.click();
  await expect(commandBar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(commandBar(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  chunk.release();
  // A load that lands after closing does not open it again.
  await page.waitForLoadState('networkidle');
  await expect(commandBar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(commandBar(page).getByRole('combobox')).toBeFocused();
});

// When the loaded field takes the first one's place, focus rests on the page for a moment
// before the new field takes it. An Escape in that moment must still close the frame.
test('Escape closes the frame while focus is out of it, as when the field is swapped', async ({
  page,
}) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  await banner(page)
    .getByRole('button', { name: /Search or run a command/ })
    .click();
  await expect(commandBar(page)).toBeVisible();
  // One step, so nothing can move focus back between the two.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(commandBar(page)).toBeHidden();
  chunk.release();
});

interface Held {
  holdTasks: boolean;
  heldTasks: (() => void)[];
}

// React runs its default work from MessageChannel messages. Holding them leaves the loaded
// field's render pending, so the next key press is the thing that flushes it.
async function holdReactTasks(page: Page): Promise<{
  hold: () => Promise<void>;
  held: () => Promise<number>;
  release: () => Promise<void>;
}> {
  await page.addInitScript(() => {
    const w = window as unknown as Held;
    w.holdTasks = false;
    w.heldTasks = [];
    const Real = window.MessageChannel;
    window.MessageChannel = class extends Real {
      constructor() {
        super();
        const port = this.port2;
        const send = port.postMessage.bind(port) as (message: unknown) => void;
        port.postMessage = (message: unknown) => {
          if (w.holdTasks)
            w.heldTasks.push(() => {
              send(message);
            });
          else send(message);
        };
      }
    };
  });
  return {
    hold: () =>
      page.evaluate(() => {
        (window as unknown as Held).holdTasks = true;
      }),
    held: () => page.evaluate(() => (window as unknown as Held).heldTasks.length),
    release: () =>
      page.evaluate(() => {
        const w = window as unknown as Held;
        w.holdTasks = false;
        for (const run of w.heldTasks.splice(0)) run();
      }),
  };
}

// On the pages table, an Escape after a click changes focus visibility for the grid's cells,
// a sync update that also renders the waiting field swap before React delivers the key. The
// key's own field is gone by then, so nothing in the dialog hears it.
test('Escape closes the frame when the loaded field takes over during the key press', async ({
  page,
}) => {
  const tasks = await holdReactTasks(page);
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, `${ROUTES.success}/pages`);
  await banner(page)
    .getByRole('button', { name: /Search or run a command/ })
    .click();
  await expect(commandBar(page)).toBeVisible();
  await tasks.hold();
  chunk.release();
  // The code has landed and its render waits in the held queue.
  await expect.poll(tasks.held).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(commandBar(page)).toBeHidden();
  await tasks.release();
  await expect(commandBar(page)).toBeHidden();
});

test('a failed chunk closes the frame, shows the error toast, and the next press works', async ({
  page,
}) => {
  const chunk = await routeCommandBar(page, 'fail');
  await openShell(page, ROUTES.overview);
  await watchFirstFrame(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect.poll(() => firstFrame(page)).toBe(true);
  await expect(notifications(page).getByRole('alert')).toHaveText(
    'Could not open search. Try again.',
  );
  await expect(commandBar(page)).toBeHidden();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  expect(chunk.requested(), 'the command bar chunk was requested and refused').toBeGreaterThan(0);
  await page.unrouteAll({ behavior: 'wait' });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(commandBar(page).getByRole('combobox')).toBeFocused();
});
