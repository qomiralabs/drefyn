import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { open, PAGES, THEMES, WIDTHS, type Width } from './fixtures.ts';
import { IMAGE, IMAGE_MARKER } from './image.ts';

// Fonts render differently on every host, so a baseline is only made or compared inside the
// pinned Linux image on amd64, where CI runs.
test.beforeAll(() => {
  const inside =
    process.env[IMAGE_MARKER] === IMAGE &&
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    existsSync('/ms-playwright');
  if (!inside) throw new Error(`visual runs only in the pinned Playwright image (${IMAGE_MARKER})`);
});

for (const target of PAGES) {
  for (const theme of THEMES) {
    for (const width of Object.keys(WIDTHS) as Width[]) {
      test(`${target.id} looks as approved in ${theme} at ${width}`, async ({
        page,
        browserName,
      }) => {
        await open(page, target, theme, width);
        await expect(page).toHaveScreenshot(`${browserName}-${target.id}-${theme}-${width}.png`, {
          fullPage: true,
        });
      });
    }
  }
}
