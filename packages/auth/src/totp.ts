import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEqual } from './keys.ts';

export type FactorKind = 'totp' | 'recovery_code';

// HMAC-SHA1 with 6 digits every 30 seconds is what every authenticator app shows by
// default. SHA-256 is safer on paper, but apps that ignore the parameter show wrong codes,
// and HMAC-SHA1 has no known weakness that matters here.
export const TOTP_SECRET_BYTES = 20;
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

// The current step and the one before it, for delay between reading a code and sending it.
// Never the next step, and never config. A code lives up to 60 seconds; the replay guard
// ends it on first use, together with every older one.
export const ACCEPTED_TOTP_STEPS: readonly [0, -1] = Object.freeze([0, -1] as const);

// Plenty for six digits with spaces between; anything longer is not a code.
const MAX_TYPED = 32;
const SIX_DIGITS = /^[0-9]{6}$/;

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

// RFC 4226 HOTP: dynamic truncation of HMAC-SHA1 over the 8 byte big endian counter.
export function hotp(secret: Uint8Array, counter: number, digits: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('a counter is a whole number from 0');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret: Uint8Array, step: number): string {
  return hotp(secret, step, TOTP_DIGITS);
}

// The six digits a person meant, with spaces and tabs a paste or a grouped display added
// taken out, or null for anything else.
function cleaned(typed: string): string | null {
  if (typed.length > MAX_TYPED) return null;
  const digits = typed.replace(/\s/g, '');
  return SIX_DIGITS.test(digits) ? digits : null;
}

// The step that matched, or null. Both steps are computed and compared every time, so
// timing says nothing about which one matched or how far the input got. When both match,
// the higher one wins, so the replay guard moves as far as it can.
export function matchTotp(secret: Uint8Array, typed: string, currentStep: number): number | null {
  if (!Number.isSafeInteger(currentStep) || currentStep < 1) {
    throw new RangeError('the current step is a whole number from 1');
  }
  const digits = cleaned(typed);
  // A malformed input is compared against a value no code can equal, so the work matches.
  const input = Buffer.from(digits ?? 'xxxxxx', 'ascii');
  let matched: number | null = null;
  for (const offset of ACCEPTED_TOTP_STEPS) {
    const step = currentStep + offset;
    const same = constantTimeEqual(Buffer.from(totpCode(secret, step), 'ascii'), input);
    if (same && digits !== null && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

// RFC 4648 base32, upper case and unpadded, the form otpauth URIs carry.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((acc >> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((acc << (5 - bits)) & 31);
  return out;
}

export interface OtpauthInput {
  readonly issuer: string;
  // The person's address, so they can tell accounts apart in the app. Personal data: the
  // URI is never logged, stored or put in a link.
  readonly account: string;
  readonly secret: Uint8Array;
}

// Key URI format: the label is "issuer:account", each part escaped so neither can add a
// parameter or a second colon, and the issuer is repeated as a parameter for newer apps.
export function otpauthUri(input: OtpauthInput): string {
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.account);
  const secret = base32Encode(input.secret);
  return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
