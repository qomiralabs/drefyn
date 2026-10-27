import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../src/react/index.ts';
import { tokens } from '../src/index.ts';
import {
  expect,
  ORIGIN,
  openStory,
  rgb,
  sameSize,
  storiesTagged,
  storyIds,
  sweepTimeout,
  test,
  THEMES,
} from './fixtures.ts';

interface DisabledLook {
  name: string;
  color: string;
  fill: string;
  // Every opacity from the element up to the root, so a dimmed wrapper is caught too.
  opacities: string[];
}

// Every element marked aria-disabled, with the label colour a reader sees: for a hidden
// input that is its label's, otherwise its own. Busy buttons are aria-disabled too, but keep
// their variant's paint, so they are checked on their own below.
async function disabledLooks(page: Page): Promise<DisabledLook[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-disabled="true"]:not([data-busy])')].map((el) => {
      const shown = el instanceof HTMLInputElement ? (el.closest('label') ?? el) : el;
      const opacities: string[] = [];
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        opacities.push(getComputedStyle(node).opacity);
      }
      return {
        name: shown.textContent.trim(),
        color: getComputedStyle(shown).color,
        fill: getComputedStyle(el).backgroundColor,
        opacities,
      };
    }),
  );
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test('the disabled and busy tags are used, so the checks below have stories to run on', () => {
  expect(storiesTagged('disabled').length).toBeGreaterThanOrEqual(3);
  expect(storiesTagged('busy').length).toBeGreaterThanOrEqual(1);
});

for (const theme of THEMES) {
  for (const id of storiesTagged('disabled')) {
    test(`${id} paints disabled controls with the disabled family and full opacity in ${theme}`, async ({
      page,
    }) => {
      await openStory(page, id, theme);
      const looks = await disabledLooks(page);
      expect(looks.length, 'disabled controls in the story').toBeGreaterThan(0);
      for (const look of looks) {
        expect(
          look.opacities.every((o) => o === '1'),
          `${look.name} opacity`,
        ).toBe(true);
        expect(look.color, `${look.name} colour`).toBe(rgb(tokens.color.disabled.text[theme]));
        expect(
          [rgb(tokens.color.disabled.fill[theme]), TRANSPARENT],
          `${look.name} fill`,
        ).toContain(look.fill);
      }
    });
  }

  test(`a busy button keeps its variant's paint, a progress cursor and full opacity in ${theme}`, async ({
    page,
  }) => {
    const ids = storiesTagged('busy');
    expect(ids).toContain('components-button--busy');
    await openStory(page, 'components-button--busy', theme);
    const expected = {
      Publishing: {
        fill: rgb(tokens.color.accent.ink[theme]),
        color: rgb(tokens.color.accent.on[theme]),
      },
      'Saving draft': {
        fill: rgb(tokens.color.surface.ground[theme]),
        color: rgb(tokens.color.text.body[theme]),
      },
    };
    for (const [name, paint] of Object.entries(expected)) {
      const button = page.getByRole('button', { name });
      await expect(button, name).toHaveAttribute('aria-disabled', 'true');
      await expect(button, name).toHaveAttribute('data-busy');
      const look = () =>
        button.evaluate((el) => {
          const opacities: string[] = [];
          for (let node: Element | null = el; node !== null; node = node.parentElement) {
            opacities.push(getComputedStyle(node).opacity);
          }
          const style = getComputedStyle(el);
          return {
            fill: style.backgroundColor,
            color: style.color,
            cursor: style.cursor,
            dimmed: opacities.some((o) => o !== '1'),
          };
        });
      const rest = { ...paint, cursor: 'progress', dimmed: false };
      await expect.poll(look, { message: name }).toEqual(rest);
      // No hover change: the fill under the pointer is the fill at rest.
      await button.hover();
      await expect.poll(look, { message: `${name} hovered` }).toEqual(rest);
    }
  });

  test(`no story shows a disabled or busy control without its tag in ${theme}`, async ({
    page,
  }) => {
    const ids = storyIds();
    test.setTimeout(sweepTimeout(ids.length));
    const disabled = new Set(storiesTagged('disabled'));
    const busy = new Set(storiesTagged('busy'));
    const untagged: string[] = [];
    for (const id of ids) {
      await openStory(page, id, theme);
      const found = {
        disabled: await page.locator('[aria-disabled="true"]:not([data-busy])').count(),
        busy: await page.locator('[data-busy]').count(),
      };
      if (found.disabled > 0 && !disabled.has(id))
        untagged.push(`${id} disabled (${found.disabled})`);
      if (found.busy > 0 && !busy.has(id)) untagged.push(`${id} busy (${found.busy})`);
    }
    expect(untagged).toEqual([]);
  });

  test(`icons draw with the icon stroke token, no fill and a stroke that does not scale in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-icons--all', theme);
    const shapes = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '#storybook-root svg [d], #storybook-root svg rect, #storybook-root svg circle, #storybook-root svg line',
        ),
      ].map((el) => {
        const style = getComputedStyle(el);
        return {
          icon: el.closest('svg')?.getAttribute('data-icon') ?? '',
          width: style.strokeWidth,
          fill: style.fill,
          effect: style.getPropertyValue('vector-effect'),
        };
      }),
    );
    // Seven icons, three sizes each, at least one shape per icon.
    expect(shapes.length).toBeGreaterThanOrEqual(21);
    for (const shape of shapes) {
      expect(shape, shape.icon).toEqual({
        icon: shape.icon,
        width: `${tokens.stroke.icon}px`,
        fill: 'none',
        effect: 'non-scaling-stroke',
      });
    }
  });

  test(`icons take the three icon sizes in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-icons--all', theme);
    const sizes = await page.evaluate(() =>
      [
        ...new Set(
          [...document.querySelectorAll('#storybook-root svg')].map(
            (svg) => `${svg.getBoundingClientRect().width}x${svg.getBoundingClientRect().height}`,
          ),
        ),
      ].sort(),
    );
    const { sm, md, lg } = tokens.size.icon;
    expect(sizes).toEqual([`${sm}x${sm}`, `${md}x${md}`, `${lg}x${lg}`].sort());
  });

  test(`skeletons paint the skeleton fill and never animate in ${theme}`, async ({ page }) => {
    for (const id of [
      'components-skeleton--shapes',
      'components-skeleton--loading-text',
      'components-skeleton--loading-rows',
    ]) {
      await openStory(page, id, theme);
      const blocks = await page.evaluate(() =>
        [...document.querySelectorAll('#storybook-root span[aria-hidden="true"]')].map((el) => {
          const style = getComputedStyle(el);
          return {
            fill: style.backgroundColor,
            animation: style.animationName,
            height: el.getBoundingClientRect().height,
          };
        }),
      );
      expect(blocks.length, id).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block.fill, id).toBe(rgb(tokens.color.skeleton.fill[theme]));
        expect(block.animation, id).toBe('none');
        expect(block.height, id).toBeGreaterThan(0);
      }
    }
  });

  test(`badges set the word in state text on paper and in body text on a fill in ${theme}`, async ({
    page,
  }) => {
    const words = {
      fresh: 'Verified 2 days ago',
      stale: 'Out of date for 2 days',
      broken: 'Wrong',
      neutral: 'Maintenance',
    } as const;
    for (const [id, onFill] of [
      ['components-badge--states', false],
      ['components-badge--on-fill', true],
    ] as const) {
      await openStory(page, id, theme);
      for (const [state, word] of Object.entries(words) as [keyof typeof words, string][]) {
        const badge = page.locator(`#storybook-root [data-state="${state}"]`);
        await expect(badge, `${id} ${state}`).toHaveText(word);
        await expect(badge, `${id} ${state}`).toHaveCSS(
          'color',
          rgb(onFill ? tokens.color.text.body[theme] : tokens.color.state[state].text[theme]),
        );
      }
    }
  });
}

// With JS off the server markup alone has to keep the width, so it is rendered here in node
// and loaded with the built stylesheets and scripts disabled.
const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'storybook-static', 'assets');
const PAIRS = [
  ['Publish', 'Publishing update'],
  ['Save draft and close', 'Saving'],
] as const;

test.describe('with JS off', () => {
  test.use({ javaScriptEnabled: false });

  for (const theme of THEMES) {
    test(`a button that can be busy has the same width at rest and busy from server markup in ${theme}`, async ({
      page,
    }) => {
      const sheets = readdirSync(assets).filter((file) => file.endsWith('.css'));
      expect(sheets.length).toBeGreaterThan(0);
      const markup = PAIRS.map(([rest, busy]) =>
        [false, true]
          .map((state) =>
            renderToStaticMarkup(
              createElement(Button, { busy: state, busyLabel: busy, name: rest, children: rest }),
            ),
          )
          .join(''),
      ).join('');
      const html = `<!doctype html><html lang="en" data-theme="${theme}"><head>${sheets
        .map((file) => `<link rel="stylesheet" href="/assets/${file}">`)
        .join('')}</head><body><main>${markup}</main></body></html>`;
      await page.route(`${ORIGIN}/no-js.html`, (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      // Page scripts are off, so the fonts are not awaited from script; both buttons of a
      // pair are measured together until the layout settles, and must then be equal.
      await page.goto('/no-js.html', { waitUntil: 'load' });
      for (const [rest, busy] of PAIRS) {
        const pair = page.locator(`button[name="${rest}"]`);
        await expect(pair, rest).toHaveCount(2);
        await expect
          .poll(
            async () => {
              const [a, b] = [await pair.nth(0).boundingBox(), await pair.nth(1).boundingBox()];
              return sameSize(a, b) ? 'same' : JSON.stringify([a, b]);
            },
            { message: `${rest} and ${busy}` },
          )
          .toBe('same');
      }
    });
  }
});
