import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyGitHubWebhook } from '../src/index.ts';

// Counts the comparisons the check makes, so a refactor to === or Buffer.equals fails here.
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const secret = new TextEncoder().encode('a-webhook-secret-for-tests-only');
const body = new TextEncoder().encode('{"zen":"Practicality beats purity."}');
const good = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

describe('the signature compare', () => {
  it('goes through timingSafeEqual for a good and for a bad signature of the right shape', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    expect(verifyGitHubWebhook(body, good, secret)).toBe(true);
    expect(verifyGitHubWebhook(body, good.replace(/^sha256=./, 'sha256=0'), secret)).toBe(
      good.startsWith('sha256=0'),
    );
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [a, b] of compare.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it('refuses a malformed header before comparing, since its length is public anyway', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    expect(verifyGitHubWebhook(body, 'sha256=abc', secret)).toBe(false);
    expect(verifyGitHubWebhook(body, undefined, secret)).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });
});
