import { reducedFadeCapMs } from '../src/index.ts';
import { expect, FOUNDATIONS, openStory, test, THEMES } from './fixtures.ts';

// Properties that move or resize something; under reduced motion none of them may animate.
const MOVING =
  /^(?:all|transform|translate|scale|rotate|top|right|bottom|left|inset.*|margin.*|width|height|max-.*|min-.*)$/;

interface Transition {
  element: string;
  property: string;
  ms: number;
}

for (const theme of THEMES) {
  test(`nothing travels and fades stay short in ${theme}`, async ({ page }) => {
    await openStory(page, FOUNDATIONS, theme);
    const transitions: Transition[] = await page.evaluate(() => {
      const ms = (value: string) =>
        value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
      const found: Transition[] = [];
      for (const el of document.querySelectorAll('#storybook-root *')) {
        const style = getComputedStyle(el);
        const properties = style.transitionProperty.split(',').map((p) => p.trim());
        const durations = style.transitionDuration.split(',').map((d) => ms(d.trim()));
        properties.forEach((property, i) => {
          // Durations repeat to fill the property list, as the CSS spec says.
          const duration = durations[i % durations.length] ?? 0;
          if (duration > 0) {
            found.push({ element: el.className.toString(), property, ms: duration });
          }
        });
      }
      return found;
    });
    // The motion samples carry fades; without them this test would pass on nothing.
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.filter((t) => MOVING.test(t.property))).toEqual([]);
    expect(transitions.filter((t) => t.ms > reducedFadeCapMs)).toEqual([]);
  });
}
