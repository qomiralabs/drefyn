import { parsePublicId, toPublicId, type IdOf, type OrganizationId } from '@drefyn/tenancy';
import { decodeSecret, encodeSecret, parseInvitationToken } from './tokens.ts';

// Tokens ride in the fragment, which browsers never send, so they stay out of request
// lines, access logs and Referer. The page reads the fragment and posts it.
const INVITE_PATH = '/invite';
const BLOCK_PATH = '/invite/block';

function linkTo(origin: string, path: string, token: string): URL {
  const url = new URL(path, origin);
  url.hash = token;
  return url;
}

export function invitationLink(origin: string, token: string): URL {
  if (parseInvitationToken(token) === null) throw new RangeError('not an invitation token');
  return linkTo(origin, INVITE_PATH, token);
}

export function invitationBlockLink(origin: string, token: string): URL {
  if (parseBlockToken(token) === null) throw new RangeError('not a block token');
  return linkTo(origin, BLOCK_PATH, token);
}

// The "I did not expect this" link. It needs no row: the tag proves auth made it, and it
// carries the address only as its keyed hash, so it outlives the invitation it came with.
export interface BlockToken {
  readonly organizationId: OrganizationId;
  readonly invitationId: IdOf<'inv'>;
  readonly emailHmac: Buffer;
  // Unix seconds, ten digits.
  readonly expiresAt: number;
  readonly tag: Buffer;
}

const BODY = '[0-9a-hjkmnp-tv-z]{26}';
const SECRET = '[0-9a-hjkmnp-tv-z]{52}';
const BLOCK = new RegExp(`^(${BODY})\\.(${BODY})\\.(${SECRET})\\.([1-9][0-9]{9})\\.(${SECRET})$`);

const bodyOf = <K extends 'org' | 'inv'>(kind: K, id: IdOf<K>) =>
  toPublicId(kind, id).slice(kind.length + 1);

function idFrom<K extends 'org' | 'inv'>(kind: K, body: string): IdOf<K> | null {
  try {
    return parsePublicId(kind, `${kind}_${body}`);
  } catch {
    return null;
  }
}

export function formatBlockToken(token: BlockToken): string {
  if (!Number.isSafeInteger(token.expiresAt) || String(token.expiresAt).length !== 10) {
    throw new RangeError('expiry is ten digits of unix seconds');
  }
  return [
    bodyOf('org', token.organizationId),
    bodyOf('inv', token.invitationId),
    encodeSecret(token.emailHmac),
    String(token.expiresAt),
    encodeSecret(token.tag),
  ].join('.');
}

// Null for anything but the one canonical spelling of a block token.
export function parseBlockToken(value: unknown): BlockToken | null {
  if (typeof value !== 'string') return null;
  const match = BLOCK.exec(value);
  if (match === null) return null;
  const [, org, inv, hmac, expiry, tag] = match;
  if (org === undefined || inv === undefined || hmac === undefined) return null;
  if (expiry === undefined || tag === undefined) return null;
  const organizationId = idFrom('org', org);
  const invitationId = idFrom('inv', inv);
  const emailHmac = decodeSecret(hmac);
  const tagBytes = decodeSecret(tag);
  if (organizationId === null || invitationId === null) return null;
  if (emailHmac === null || tagBytes === null) return null;
  return { organizationId, invitationId, emailHmac, expiresAt: Number(expiry), tag: tagBytes };
}
