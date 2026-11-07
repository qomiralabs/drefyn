import { setTimeout as wait } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';

const LONGER_THAN_THE_LIMIT_MS = 3_000;

it('waits on async work past the limit', { timeout: LONGER_THAN_THE_LIMIT_MS * 3 }, async () => {
  await wait(LONGER_THAN_THE_LIMIT_MS);
  expect(true).toBe(true);
});

it('holds fake timers past the limit', { timeout: LONGER_THAN_THE_LIMIT_MS * 3 }, async () => {
  vi.useFakeTimers();
  try {
    await wait(LONGER_THAN_THE_LIMIT_MS);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
