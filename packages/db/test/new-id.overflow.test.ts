import type * as Crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every random draw is all ones, so the second id in a millisecond overflows the counter.
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomFillSync: <T extends Uint8Array>(bytes: T): T => bytes.fill(0xff),
  };
});

const { newId } = await import('../src/new-id.ts');

const timestampOf = (id: string) => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);

afterEach(() => {
  vi.useRealTimers();
});

describe('newId when the counter runs out within a millisecond', () => {
  it('moves to the next millisecond and still increases', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    const first = newId('evt');
    const second = newId('evt');
    expect(timestampOf(first)).toBe(Date.parse('2031-01-01T00:00:00.000Z'));
    expect(timestampOf(second)).toBe(Date.parse('2031-01-01T00:00:00.001Z'));
    expect(second > first).toBe(true);
  });
});
