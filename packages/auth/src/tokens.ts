import {
  idOf,
  parsePublicId,
  toPublicId,
  type IdKind,
  type IdOf,
  type OrganizationId,
  type UserId,
} from '@drefyn/tenancy';

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

// Tokens carry id bodies without their prefix; the kind comes from the position, and the
// tenancy codec, which owns the format, validates and brands it.
function decodeBody<K extends IdKind>(kind: K, text: string, start: number): IdOf<K> | null {
  const body = text.slice(start, start + BODY_LENGTH);
  if (body.length !== BODY_LENGTH) return null;
  try {
    return parsePublicId(kind, `${kind}_${body}`);
  } catch {
    return null;
  }
}

const bodyOf = <K extends IdKind>(kind: K, id: IdOf<K>) =>
  toPublicId(kind, id).slice(kind.length + 1);

// Email challenges have no public id kind; their body decodes through the user kind,
// since the format is shared, and comes back as a canonical UUID.
const challengeBody = (uuid: string) => bodyOf('usr', idOf('usr', uuid));

interface Layout<A extends IdKind, B extends IdKind> {
  readonly prefix: string;
  readonly separator: string;
  readonly kinds: readonly [A, B];
}

// prefix, body, separator, body, separator, secret: the shape every credential shares.
function parseTriple<A extends IdKind, B extends IdKind>(
  value: unknown,
  layout: Layout<A, B>,
): [IdOf<A>, IdOf<B>, Buffer] | null {
  const length = layout.prefix.length + BODY_LENGTH * 2 + 2 + SECRET_LENGTH;
  if (typeof value !== 'string' || value.length !== length) return null;
  if (!value.startsWith(layout.prefix)) return null;
  const a = layout.prefix.length;
  const b = a + BODY_LENGTH + 1;
  const c = b + BODY_LENGTH + 1;
  if (value.charAt(b - 1) !== layout.separator || value.charAt(c - 1) !== layout.separator) {
    return null;
  }
  const first = decodeBody(layout.kinds[0], value, a);
  const second = decodeBody(layout.kinds[1], value, b);
  const secret = decodeSecret(value.slice(c));
  if (first === null || second === null || secret === null) return null;
  return [first, second, secret];
}

function formatTriple<A extends IdKind, B extends IdKind>(
  layout: Layout<A, B>,
  first: IdOf<A>,
  second: IdOf<B>,
  secret: Uint8Array,
): string {
  const [a, b] = layout.kinds;
  return `${layout.prefix}${bodyOf(a, first)}${layout.separator}${bodyOf(b, second)}${layout.separator}${encodeSecret(secret)}`;
}

const SESSION: Layout<'usr', 'ses'> = { prefix: 'v1.', separator: '.', kinds: ['usr', 'ses'] };
const API_KEY: Layout<'org', 'key'> = { prefix: 'drf_ak_', separator: '_', kinds: ['org', 'key'] };
const INVITATION: Layout<'org', 'inv'> = { prefix: '', separator: '.', kinds: ['org', 'inv'] };

export interface SessionToken {
  readonly userId: UserId;
  readonly sessionId: IdOf<'ses'>;
  readonly secret: Buffer;
}

export interface SessionTokenInput {
  readonly userId: UserId;
  readonly sessionId: IdOf<'ses'>;
  readonly secret: Uint8Array;
}

export function formatSessionToken(token: SessionTokenInput): string {
  return formatTriple(SESSION, token.userId, token.sessionId, token.secret);
}

export function parseSessionToken(value: unknown): SessionToken | null {
  const parts = parseTriple(value, SESSION);
  if (parts === null) return null;
  return { userId: parts[0], sessionId: parts[1], secret: parts[2] };
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
  return { organizationId: parts[0], keyId: parts[1], secret: parts[2] };
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
  readonly invitationId: IdOf<'inv'>;
  readonly secret: Buffer;
}

export function formatInvitationToken(token: {
  readonly organizationId: OrganizationId;
  readonly invitationId: IdOf<'inv'>;
  readonly secret: Uint8Array;
}): string {
  return formatTriple(INVITATION, token.organizationId, token.invitationId, token.secret);
}

export function parseInvitationToken(value: unknown): InvitationToken | null {
  const parts = parseTriple(value, INVITATION);
  if (parts === null) return null;
  return { organizationId: parts[0], invitationId: parts[1], secret: parts[2] };
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
  return `${challengeBody(fragment.challengeId)}.${fragment.code}`;
}

// The part after # in the sign in link: the challenge body, a dot, the 8 digit code.
export function parseVerifyFragment(value: unknown): VerifyFragment | null {
  if (typeof value !== 'string' || value.length !== BODY_LENGTH + 1 + 8) return null;
  if (value.charAt(BODY_LENGTH) !== '.') return null;
  const challengeId = decodeBody('usr', value, 0);
  const code = parseCode(value.slice(BODY_LENGTH + 1));
  if (challengeId === null || code === null) return null;
  return { challengeId, code };
}
