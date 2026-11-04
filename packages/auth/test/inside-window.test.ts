import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Harness } from './integration/support/harness.ts';
import { insideWindow, insideWindowTimeout } from './integration/support/passwords.ts';

// The default timeout of the integration config: what a test has for its own work.
const WORK_MS = 60_000;
const WINDOW_SECONDS = 900;
const BUDGET_SECONDS = 60;

const waited = async (left: number) => {
  const h = { sql: () => Promise.resolve(String(left)) } as unknown as Harness;
  const started = Date.now();
  const done = insideWindow(h, WINDOW_SECONDS, BUDGET_SECONDS);
  await vi.runAllTimersAsync();
  await done;
  return Date.now() - started;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('does not wait with more than the budget left in the window', async () => {
  expect(await waited(BUDGET_SECONDS + 1)).toBe(0);
  expect(await waited(WINDOW_SECONDS)).toBe(0);
});

it('waits past the edge with the budget or less left', async () => {
  expect(await waited(BUDGET_SECONDS)).toBe((BUDGET_SECONDS + 1) * 1000);
  expect(await waited(1)).toBe(2000);
});

it('leaves a test its full time for work after the longest wait, at every second', async () => {
  for (let left = 1; left <= WINDOW_SECONDS; left += 1) {
    const ms = await waited(left);
    expect(ms + WORK_MS).toBeLessThanOrEqual(insideWindowTimeout(BUDGET_SECONDS));
  }
});
