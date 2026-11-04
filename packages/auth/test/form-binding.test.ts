import { describe, expect, it } from 'vitest';
import { checkFormBinding, formBindingField, type BrowserContext } from '../src/index.ts';
import { encodeSecret } from '../src/tokens.ts';
import { config } from './session-fixtures.ts';

const pre = encodeSecret(new Uint8Array(32).fill(7));
const other = encodeSecret(new Uint8Array(32).fill(8));

const browser = (value?: string): BrowserContext => ({
  ip: '203.0.113.9',
  userAgent: 'Firefox',
  cookies: new Map(value === undefined ? [] : [[config.cookies.pre, value]]),
});

describe('the pre sign in form binding', () => {
  const field = formBindingField(config, new Uint8Array(32).fill(7));

  it('accepts the field made for this cookie', () => {
    expect(checkFormBinding(config, browser(pre), field)).toBe(true);
  });

  it.each([
    ['no cookie', undefined, field],
    ['a cookie that is not a secret', 'nonsense', field],
    ['another browser', other, field],
    ['an empty field', pre, ''],
    ['a short field', pre, field.slice(1)],
    ['a field outside the alphabet', pre, `${field.slice(1)}+`],
  ])('refuses %s', (_name, cookie, value) => {
    expect(checkFormBinding(config, browser(cookie), value)).toBe(false);
  });
});
