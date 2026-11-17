import { describe, expect, it } from 'vitest';
import { expectFixture } from './helpers.ts';

describe('typescript extraction', () => {
  it('finds exactly the symbols, signatures and docs in the expectation file', async () => {
    const result = await expectFixture('typescript', 'typescript/client.ts', 'src/client.ts');
    expect(result.routes).toEqual([]);
  });
});
