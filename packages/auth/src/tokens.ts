import { idOf, parsePublicId, toPublicId, type IdOf, type OrganizationId } from '@drefyn/tenancy';

// The public id alphabet: lowercase Crockford base32 without i, l, o and u.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const VALUE: readonly number[] = Array.from({ length: 128 }, (_, code) =>
  ALPHABET.indexOf(String.fromCharCode(code)),
);

export const SECRET_BYTES = 32;
// 256 bits in 52 symbols of 5 bits leaves 4 spare bits, kept zero in front (as the id
// codec does), so each secret has exactly one encoding.
export const SECRET_LENGTH = 52;
const BODY_LENGTH = 26;
const SECRET_PAD_BITS = SECRET_LENGTH * 5 - SECRET_BYTES * 8;

export function encodeSecret(bytes: Uint8Array): string {
  if (bytes.length !== SECRET_BYTES) throw new RangeError('a secret is 32 bytes');
  let acc = 0;
  let bits = SECRET_PAD_BITS;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

const symbol = (text: string, i: number) => VALUE[text.charCodeAt(i)] ?? -1;

// Null for anything but the one canonical encoding of 32 bytes.
export function decodeSecret(text: unknown): Buffer | null {
  if (typeof text !== 'string' || text.length !== SECRET_LENGTH) return null;
  const first = symbol(text, 0);
  if (first < 0 || first >> (5 - SECRET_PAD_BITS) !== 0) return null;
  const out = Buffer.alloc(SECRET_BYTES);
  let acc = first;
  let bits = 5 - SECRET_PAD_BITS;
  let at = 0;
  for (let i = 1; i < SECRET_LENGTH; i += 1) {
    const value = symbol(text, i);
    if (value < 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (acc >> bits) & 255;
      at += 1;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

// The body format is the same for every id kind and tenancy owns the codec, so bodies of
// kinds tenancy does not list yet (sessions, invitations, challenges) decode through it
// too and come back as canonical UUIDs.
function decodeBody(text: string, start: number): string | null {
  const body = text.slice(start, start + BODY_LENGTH);
  if (body.length !== BODY_LENGTH) return null;
  try {
    return parsePublicId('usr', `usr_${body}`);
  } catch {
    return null;
  }
}

const bodyOf = (uuid: string) => toPublicId('usr', idOf('usr', uuid)).slice(4);

interface Layout {
  readonly prefix: string;
  readonly separator: string;
}

// prefix, body, separator, body, separator, secret: the shape every credential shares.
function parseTriple(value: unknown, layout: Layout): [string, string, Buffer] | null {
  const length = layout.prefix.length + BODY_LENGTH * 2 + 2 + SECRET_LENGTH;
  if (typeof value !== 'string' || value.length !== length) return null;
  if (!value.startsWith(layout.prefix)) return null;
  const a = layout.prefix.length;
  const b = a + BODY_LENGTH + 1;
  const c = b + BODY_LENGTH + 1;
  if (value.charAt(b - 1) !== layout.separator || value.charAt(c - 1) !== layout.separator) {
    return null;
  }
  const first = decodeBody(value, a);
  const second = decodeBody(value, b);
  const secret = decodeSecret(value.slice(c));
  if (first === null || second === null || secret === null) return null;
  return [first, second, secret];
}

const formatTriple = (layout: Layout, first: string, second: string, secret: Uint8Array) =>
  `${layout.prefix}${bodyOf(first)}${layout.separator}${bodyOf(second)}${layout.separator}${encodeSecret(secret)}`;

const SESSION: Layout = { prefix: 'v1.', separator: '.' };
const API_KEY: Layout = { prefix: 'drf_ak_', separator: '_' };
const INVITATION: Layout = { prefix: '', separator: '.' };

export interface SessionToken {
  readonly userId: IdOf<'usr'>;
  // A canonical UUID; the sessions code brands it once tenancy has the session kind.
  readonly sessionId: string;
  readonly secret: Buffer;
}

export interface SessionTokenInput {
  readonly userId: IdOf<'usr'>;
  readonly sessionId: string;
  readonly secret: Uint8Array;
}

export function formatSessionToken(token: SessionTokenInput): string {
  return formatTriple(SESSION, token.userId, token.sessionId, token.secret);
}

export function parseSessionToken(value: unknown): SessionToken | null {
  const parts = parseTriple(value, SESSION);
  if (parts === null) return null;
  return { userId: idOf('usr', parts[0]), sessionId: parts[1], secret: parts[2] };
}

export interface ApiKeyParts {
  readonly organizationId: OrganizationId;
  readonly keyId: IdOf<'key'>;
  readonly secret: Buffer;
}

export function formatApiKey(key: {
  readonly organizationId: OrganizationId;
  readonly keyId: IdOf<'key'>;
  readonly secret: Uint8Array;
}): string {
  return formatTriple(API_KEY, key.organizationId, key.keyId, key.secret);
}

export function parseApiKey(value: unknown): ApiKeyParts | null {
  const parts = parseTriple(value, API_KEY);
  if (parts === null) return null;
  return { organizationId: idOf('org', parts[0]), keyId: idOf('key', parts[1]), secret: parts[2] };
}

const MAX_HEADER_BYTES = 512;

// Exactly one space after the scheme and nothing after the key, so a header can only
// ever name one key.
export function parseBearer(header: unknown): ApiKeyParts | null {
  if (typeof header !== 'string' || header.length > MAX_HEADER_BYTES) return null;
  if (!header.startsWith('Bearer ')) return null;
  return parseApiKey(header.slice('Bearer '.length));
}

export interface InvitationToken {
  readonly organizationId: OrganizationId;
  readonly invitationId: string;
  readonly secret: Buffer;
}

export function formatInvitationToken(token: {
  readonly organizationId: OrganizationId;
  readonly invitationId: string;
  readonly secret: Uint8Array;
}): string {
  return formatTriple(INVITATION, token.organizationId, token.invitationId, token.secret);
}

export function parseInvitationToken(value: unknown): InvitationToken | null {
  const parts = parseTriple(value, INVITATION);
  if (parts === null) return null;
  return { organizationId: idOf('org', parts[0]), invitationId: parts[1], secret: parts[2] };
}

const CODE = /^[0-9]{8}$/;

export function parseCode(value: unknown): string | null {
  return typeof value === 'string' && CODE.test(value) ? value : null;
}

export interface VerifyFragment {
  readonly challengeId: string;
  readonly code: string;
}

export function formatVerifyFragment(fragment: VerifyFragment): string {
  return `${bodyOf(fragment.challengeId)}.${fragment.code}`;
}

// The part after # in the sign in link: the challenge body, a dot, the 8 digit code.
export function parseVerifyFragment(value: unknown): VerifyFragment | null {
  if (typeof value !== 'string' || value.length !== BODY_LENGTH + 1 + 8) return null;
  if (value.charAt(BODY_LENGTH) !== '.') return null;
  const challengeId = decodeBody(value, 0);
  const code = parseCode(value.slice(BODY_LENGTH + 1));
  if (challengeId === null || code === null) return null;
  return { challengeId, code };
}
