import { createHash } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// RFC 4648 base32, lower case so the id reads as one word. Only ever given 20 bytes,
// which is exactly 32 characters, so there is never a partial group to pad.
function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  return out;
}

// The same key always gives the same id, so a retry or a second send of the same mail
// is recognisable as one message. A hash, so the key itself never shows in a header.
export function messageIdFor(idempotencyKey: string, senderDomain: string): string {
  const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest().subarray(0, 20);
  return `<${base32(digest)}@${senderDomain}>`;
}
