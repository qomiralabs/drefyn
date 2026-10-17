import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@drefyn/__name__', () => {
  it('exports its name', () => {
    expect(packageName).toBe('@drefyn/__name__');
  });
});
