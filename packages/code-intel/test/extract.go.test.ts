import { describe, expect, it } from 'vitest';
import { expectFixture } from './helpers.ts';

describe('go extraction', () => {
  it('finds exactly the symbols, signatures and docs in the expectation file', async () => {
    const result = await expectFixture('go', 'go/client.go', 'client.go');
    expect(result.routes).toEqual([]);
  });
});
