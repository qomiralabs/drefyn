import { reducedFadeCapMs, tokens } from '../src/index.ts';
import type { Page } from '@playwright/test';
import {
  expect,
  FOUNDATIONS,
  openStory,
  recordTransitions,
  storyIds,
  sweepTimeout,
  test,
  THEMES,
} from './fixtures.ts';

// Properties that move or resize something; under reduced motion none of them may animate.
const MOVING =
  /^(?:all|transform|translate|scale|rotate|top|right|bottom|left|inset.*|margin.*|width|height|max-.*|min-.*)$/;

interface Transition {
  element: string;
  property: string;
  ms: number;
}

// Every running transition in the story, the floating layer included, since menus and
// popovers render outside the story root.
function transitionsIn(page: Page): Promise<Transition[]> {
  return page.evaluate(() => {
    const ms = (value: string) =>
      value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
    const found: Transition[] = [];
    // Storybook's own chrome is left out; anything else in the body is the story's.
    const own = (el: Element) =>
      el.id === 'storybook-docs' ||
      el.tagName === 'SCRIPT' ||
      String(el.getAttribute('class')).startsWith('sb-');
    const roots = [...document.body.children].filter((el) => !own(el));
    for (const el of roots
      .flatMap((r) => (r.id === 'storybook-root' ? [] : [r]))
      .concat(roots.flatMap((r) => [...r.querySelectorAll('*')]))) {
      const style = getComputedStyle(el);
      const properties = style.transitionProperty.split(',').map((p) => p.trim());
      const durations = style.transitionDuration.split(',').map((d) => ms(d.trim()));
      properties.forEach((property, i) => {
        // Durations repeat to fill the property list, as the CSS spec says.
        const duration = durations[i % durations.length] ?? 0;
        if (duration > 0) {
          found.push({ element: el.tagName.toLowerCase(), property, ms: duration });
        }
      });
    }
    return found;
  });
}

for (const theme of THEMES) {
  test(`nothing travels and fades stay short in ${theme}`, async ({ page }) => {
    await openStory(page, FOUNDATIONS, theme);
    const transitions = await transitionsIn(page);
    // The motion samples carry fades; without them this test would pass on nothing.
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.filter((t) => MOVING.test(t.property))).toEqual([]);
    expect(transitions.filter((t) => t.ms > reducedFadeCapMs)).toEqual([]);
  });
}

for (const theme of THEMES) {
  test(`pressing the move row changes its fill and nothing travels in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, FOUNDATIONS, theme);
    const row = page.getByRole('button', { name: /^Move, base/ });
    await row.focus();
    await page.keyboard.press('Space');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    const n = Number.parseInt(tokens.color.surface.pressed[theme].slice(1), 16);
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
    const moved = await row.evaluate((el) => {
      const style = getComputedStyle(el);
      return { translate: style.translate, transform: style.transform };
    });
    expect(moved).toEqual({ translate: 'none', transform: 'none' });
  });
}

for (const theme of THEMES) {
  test(`no component story moves anything or fades past the cap in ${theme}`, async ({ page }) => {
    const ids = storyIds().filter((id) => id.startsWith('components-'));
    expect(ids.length).toBeGreaterThan(0);
    test.setTimeout(sweepTimeout(ids.length));
    const bad: string[] = [];
    let fades = 0;
    for (const id of ids) {
      await openStory(page, id, theme);
      const transitions = await transitionsIn(page);
      fades += transitions.length;
      for (const t of transitions) {
        if (MOVING.test(t.property) || t.ms > reducedFadeCapMs) {
          bad.push(`${id} ${t.element} ${t.property} ${t.ms}ms`);
        }
      }
    }
    // Buttons, switches and menu items fade colour, so a run that finds none found nothing.
    expect(fades).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  test(`a flipped switch fades colour and moves nothing in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-switch--off', theme);
    const toggle = page.getByRole('switch', { name: 'Show uptime figure' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => toggle.evaluate((el) => (el as HTMLInputElement).checked)).toBe(true);
    const moving = (await transitionsIn(page)).filter((t) => MOVING.test(t.property));
    expect(moving).toEqual([]);
  });

  test(`an open menu fades in without travelling in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-menu--default', theme);
    await page.getByRole('button', { name: 'Payments API' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    const transitions = await transitionsIn(page);
    expect(transitions.filter((t) => MOVING.test(t.property))).toEqual([]);
    expect(transitions.filter((t) => t.ms > reducedFadeCapMs)).toEqual([]);
  });
}

// Overlays and tabs fade in. Every transition the opening starts is caught as it starts, so
// a fade that never runs fails, and so does any property that moves or a fade past the cap.
const OPENED: {
  id: string;
  role: 'dialog' | 'listbox' | 'tabpanel';
  open: (page: Page) => Promise<void>;
}[] = [
  {
    id: 'components-popover--default',
    role: 'dialog',
    open: (page) => page.getByRole('button', { name: 'Filters' }).click(),
  },
  {
    id: 'components-select--default',
    role: 'listbox',
    open: (page) => page.getByRole('button', { name: /Region$/ }).click(),
  },
  {
    id: 'components-tabs--default',
    role: 'tabpanel',
    open: (page) => page.getByRole('tab', { name: 'History' }).click(),
  },
];

for (const theme of THEMES) {
  for (const { id, role, open } of OPENED) {
    test(`${id} fades in without travelling, within the cap, in ${theme}`, async ({ page }) => {
      await openStory(page, id, theme);
      const recorded = await recordTransitions(page);
      await open(page);
      await expect(page.getByRole(role)).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      const started = await recorded();
      expect(
        started.some((t) => t.property === 'opacity'),
        'an opacity fade ran',
      ).toBe(true);
      expect(started.filter((t) => MOVING.test(t.property))).toEqual([]);
      expect(started.filter((t) => t.ms > reducedFadeCapMs)).toEqual([]);
      const settled = await transitionsIn(page);
      expect(settled.filter((t) => MOVING.test(t.property))).toEqual([]);
    });
  }
}
