import { TenancyError } from './errors.ts';
import { assertKind, assertUuid, isKind, type IdKind, type IdOf } from './ids.ts';

// Crockford base32 without the hyphen and the i, l, o aliases, and lowercase only, so each
// id has exactly one public form.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const HEX = '0123456789abcdef';

// Every prefix in ID_KINDS is three letters, so every public id is 3 + 1 + 26 characters.
const PREFIX_LENGTH = 3;
const BODY_LENGTH = 26;
const PUBLIC_LENGTH = PREFIX_LENGTH + 1 + BODY_LENGTH;

const SYMBOL_VALUE: readonly number[] = Array.from({ length: 128 }, (_, code) =>
  ALPHABET.indexOf(String.fromCharCode(code)),
);

function symbolValue(text: string, index: number): number {
  return SYMBOL_VALUE[text.charCodeAt(index)] ?? -1;
}

// 128 bits padded with two leading zero bits make 130, exactly 26 symbols of 5 bits.
function encodeUuid(uuid: string): string {
  let acc = 0;
  let bits = 2;
  let out = '';
  for (let i = 0; i < uuid.length; i += 1) {
    const nibble = HEX.indexOf(uuid.charAt(i));
    if (nibble < 0) continue;
    acc = (acc << 4) | nibble;
    bits += 4;
    if (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

// Returns null when the body is not 26 symbols of the alphabet or needs more than 128 bits.
function decodeBody(text: string, start: number): string | null {
  const first = symbolValue(text, start);
  // The two padding bits must be zero; a first symbol above 7 would carry a 129th bit.
  if (first < 0 || first > 7) return null;
  let acc = first;
  let bits = 3;
  let hex = '';
  for (let i = start + 1; i < start + BODY_LENGTH; i += 1) {
    const value = symbolValue(text, i);
    if (value < 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 4) {
      bits -= 4;
      hex += HEX.charAt((acc >> bits) & 15);
      acc &= (1 << bits) - 1;
    }
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// NoInfer keeps K bound to the kind argument, so toPublicId('org', projectId) fails to compile.
export function toPublicId<K extends IdKind>(kind: K, id: NoInfer<IdOf<K>>): string {
  assertKind(kind);
  // The brand is only a type; a cast can still smuggle in any string.
  assertUuid(id);
  return `${kind}_${encodeUuid(id)}`;
}

export function parsePublicId<K extends IdKind>(kind: K, value: string): IdOf<K> {
  assertKind(kind);
  const input: unknown = value;
  if (typeof input !== 'string' || input.length !== PUBLIC_LENGTH) {
    throw new TenancyError('ID_MALFORMED');
  }
  const prefix = input.slice(0, PREFIX_LENGTH);
  if (input.charAt(PREFIX_LENGTH) !== '_' || !isKind(prefix)) {
    throw new TenancyError('ID_MALFORMED');
  }
  const uuid = decodeBody(input, PREFIX_LENGTH + 1);
  if (uuid === null) throw new TenancyError('ID_MALFORMED');
  // Only a fully valid id of another kind counts as the wrong type.
  if (prefix !== kind) throw new TenancyError('ID_WRONG_TYPE');
  return uuid as IdOf<K>;
}
