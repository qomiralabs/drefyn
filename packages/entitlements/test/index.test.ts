import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@drefyn/entitlements', () => {
  it('exports its name', () => {
    expect(packageName).toBe('@drefyn/entitlements');
  });
});
