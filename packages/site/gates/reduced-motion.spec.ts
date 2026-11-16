import { reducedFadeCapMs } from '@drefyn/ui';
import { expect, test, type Page } from '@playwright/test';
import { open, PAGES, THEMES } from './fixtures.ts';

test.use({ reducedMotion: 'reduce' });

// Properties that move or resize something; under reduced motion none of them may animate.
const MOVING =
  /^(?:all|transform|translate|scale|rotate|top|right|bottom|left|inset.*|margin.*|width|height|max-.*|min-.*)$/;

interface Transition {
  element: string;
  property: string;
  ms: number;
}

function transitions(page: Page): Promise<Transition[]> {
  return page.evaluate(() => {
    const ms = (value: string) =>
      value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
    const found: Transition[] = [];
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      const properties = style.transitionProperty.split(',').map((p) => p.trim());
      const durations = style.transitionDuration.split(',').map((d) => ms(d.trim()));
      properties.forEach((property, i) => {
        // Durations repeat to fill the property list, as the CSS spec says.
        const duration = durations[i % durations.length] ?? 0;
        if (duration > 0) found.push({ element: el.tagName.toLowerCase(), property, ms: duration });
      });
    }
    return found;
  });
}

for (const target of PAGES) {
  for (const theme of THEMES) {
    test(`${target.id} moves nothing and keeps fades short under reduced motion in ${theme}`, async ({
      page,
    }) => {
      await open(page, target, theme, 'desktop');
      const found = await transitions(page);
      // Links fade colour, so a page that reports none was not measured.
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((t) => MOVING.test(t.property))).toEqual([]);
      expect(found.filter((t) => t.ms > reducedFadeCapMs)).toEqual([]);
      const running = await page.evaluate(() =>
        document.getAnimations().map((a) => a.constructor.name),
      );
      expect(running).toEqual([]);
    });
  }
}
