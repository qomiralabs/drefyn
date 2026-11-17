import { describe, expect, it } from 'vitest';
import { expectFixture } from './helpers.ts';

describe('javascript extraction', () => {
  it('finds exactly the symbols, signatures and docs in the expectation file', async () => {
    const result = await expectFixture('javascript', 'javascript/counter.js', 'lib/counter.js');
    expect(result.routes).toEqual([]);
  });
});
