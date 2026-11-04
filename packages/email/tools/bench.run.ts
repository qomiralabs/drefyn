import { expect, it } from 'vitest';
import { renderMail } from '../src/index.ts';
import { PREVIEW_MESSAGES } from '../test/fixtures/messages.ts';
import { ORIGIN } from '../test/support.ts';

const WARMUP = 50;
const RUNS = 500;
const TARGET_P95_MS = 20;

const at = (sorted: readonly number[], share: number) =>
  sorted[Math.ceil(sorted.length * share) - 1] ?? Number.POSITIVE_INFINITY;

// Reported, not gated: the target needs a quiet machine, and a busy laptop gives noise.
it('reports renderMail p50 and p95 per template', async () => {
  const lines: string[] = [];
  for (const [id, message] of PREVIEW_MESSAGES) {
    for (let i = 0; i < WARMUP; i++) await renderMail(message, { linkOrigin: ORIGIN });
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      await renderMail(message, { linkOrigin: ORIGIN });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    lines.push(
      `${id.padEnd(40)} p50 ${at(times, 0.5).toFixed(2)} ms  p95 ${at(times, 0.95).toFixed(2)} ms`,
    );
  }
  console.info(`target p95 ${TARGET_P95_MS} ms, ${RUNS} runs each\n${lines.join('\n')}`);
  expect(lines).toHaveLength(PREVIEW_MESSAGES.length);
});
