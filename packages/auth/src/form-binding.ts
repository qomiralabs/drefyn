import type { AuthConfig } from './config.ts';
import type { BrowserContext } from './cookies.ts';
import { decodeSecret } from './tokens.ts';

const LABEL = 'drefyn.pre_form.v1';
const FIELD = /^[A-Za-z0-9_-]{43}$/;

// The hidden field of a signed out form: an HMAC of the browser's pre sign in secret, which
// a page on another origin can neither read nor make.
export function formBindingField(config: AuthConfig, pre: Uint8Array): string {
  return config.keys.mac('csrf', [LABEL, pre]).toString('base64url');
}

export function checkFormBinding(
  config: AuthConfig,
  browser: BrowserContext,
  field: string,
): boolean {
  const pre = decodeSecret(browser.cookies.get(config.cookies.pre));
  if (pre === null || !FIELD.test(field)) return false;
  return config.keys.verify('csrf', [LABEL, pre], Buffer.from(field, 'base64url'));
}
