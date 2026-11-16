import { describe, expect, it } from 'vitest';
import { expectFixture } from './helpers.ts';

describe('rust extraction', () => {
  it('finds exactly the symbols, signatures and docs in the expectation file', async () => {
    const result = await expectFixture('rust', 'rust/lib.rs', 'src/lib.rs');
    expect(result.routes).toEqual([]);
  });
});
