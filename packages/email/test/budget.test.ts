import { describe, expect, it } from 'vitest';
import { renderMail } from '../src/index.ts';
import { FIXTURE_MESSAGES, PREVIEW_MESSAGES } from './fixtures/messages.ts';
import { ORIGIN } from './support.ts';

const KB = 1024;
const TARGET_KB = 40;
// Gmail clips a little above 102 KB.
const HARD_KB = 100;

// Shared runners are too noisy to hold the 20 ms target, which is measured on a quiet
// machine. This ceiling only catches a render that got several times slower.
const RENDER_CI_CEILING_MS = 60;

const render = async (message: (typeof PREVIEW_MESSAGES)[number][1]) => {
  const result = await renderMail(message, { linkOrigin: ORIGIN });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe('budgets', () => {
  it('keeps every HTML part under the target and every mail with a text part', async () => {
    const sizes: (readonly [string, number])[] = [];
    for (const [name, message] of PREVIEW_MESSAGES) {
      const mail = await render(message);
      const bytes = Buffer.byteLength(mail.html, 'utf8');
      sizes.push([name, bytes]);
      expect(bytes, name).toBeLessThan(TARGET_KB * KB);
      expect(bytes, name).toBeLessThan(HARD_KB * KB);
      expect(mail.text.trim(), name).not.toBe('');
    }
    const largest = [...sizes].sort((a, b) => b[1] - a[1])[0];
    console.info(
      `html size: ${sizes.length} parts, largest ${largest?.[0]} ${largest?.[1]} bytes, target ${TARGET_KB * KB}`,
    );
  });

  it.each(FIXTURE_MESSAGES.filter(([n]) => /sign_in$|invitation|new_device/.test(n)))(
    `renders %s in a warmed median under the ${RENDER_CI_CEILING_MS} ms CI ceiling`,
    async (_name, message) => {
      for (let i = 0; i < 5; i++) await render(message);
      const times: number[] = [];
      for (let i = 0; i < 21; i++) {
        const started = performance.now();
        await render(message);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const median = times[10] ?? Number.POSITIVE_INFINITY;
      expect(median, `median ${median.toFixed(2)} ms`).toBeLessThan(RENDER_CI_CEILING_MS);
    },
  );
});
