import { describe, expect, it } from 'vitest';
import { expectFixture } from './helpers.ts';

describe('tsx extraction', () => {
  it('finds exactly the symbols, signatures and docs in the expectation file', async () => {
    const result = await expectFixture('tsx', 'tsx/badge.tsx', 'src/badge.tsx');
    expect(result.routes).toEqual([]);
  });
});
