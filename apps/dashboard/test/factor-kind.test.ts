import { describe, expect, it } from 'vitest';
import { factorKindOf } from '../src/auth/factor-kind.ts';

describe('factorKindOf', () => {
  it.each(['123456', '123 456', ' 123456 '])('reads %j as an authenticator code', (typed) => {
    expect(factorKindOf(typed)).toBe('totp');
  });

  it.each(['12345', '1234567', 'k3m9qd-7xw2ph-c8vn4t-r6yb0a', 'abcdef', ''])(
    'reads %j as a recovery code',
    (typed) => {
      expect(factorKindOf(typed)).toBe('recovery_code');
    },
  );
});
