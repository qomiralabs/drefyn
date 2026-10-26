import { describe, expect, it } from 'vitest';
import { reducedMotionValue, renderPreview } from '../preview/build.ts';
import { renderTokensCss } from '../src/tokens/generate.ts';
import { tokens } from '../src/tokens/tokens.ts';

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// The specimen's Reduced columns must read the shipped stylesheet. Echoing the source value
// would show a timer as unchanged even if the generator started shortening it.
describe('token preview', () => {
  it('reads the reduced value from the stylesheet, falling back to the root value', () => {
    const css = [
      ':root {\n  --dr-timer-toast: 6000ms;\n  --dr-duration-base: 180ms;\n}\n',
      '@media (prefers-reduced-motion: reduce) {\n  :root {\n    --dr-timer-toast: 120ms;\n  }\n}\n',
    ].join('');
    expect(reducedMotionValue(css, '--dr-timer-toast')).toBe('120ms');
    expect(reducedMotionValue(css, '--dr-duration-base')).toBe('180ms');
    expect(() => reducedMotionValue(css, '--dr-timer-missing')).toThrow(/--dr-timer-missing/);
  });

  it('shows each timer and duration with what reduced motion actually ships', () => {
    const html = renderPreview();
    const css = renderTokensCss();
    for (const k of Object.keys(tokens.timer)) {
      const value = reducedMotionValue(css, `--dr-timer-${kebab(k)}`);
      expect(html, k).toMatch(
        new RegExp(`${kebab(k)}</th>.*?<td class="numbers">${parseInt(value)} ms</td></tr>`),
      );
    }
    for (const k of Object.keys(tokens.motion.duration)) {
      const value = reducedMotionValue(css, `--dr-duration-${kebab(k)}`);
      expect(html, k).toMatch(
        new RegExp(`${kebab(k)}</th>.*?<td class="numbers">${parseInt(value)} ms</td></tr>`),
      );
    }
  });
});
