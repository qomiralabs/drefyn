import type { OrganizationId } from '@drefyn/tenancy';
import { z } from 'zod';
import { normalizeAddress } from './address.ts';
import type { SsoConnectionId } from './auth-events.ts';
import { asId } from './session-support.ts';

export type SsoProtocol = 'oidc' | 'saml';
export type SsoConnectionStatus = 'draft' | 'test' | 'active' | 'disabled';

// Not exported. The interface below needs it as a key, so an object literal can never be one,
// and the set beside it catches a cast at run time.
const verified: unique symbol = Symbol('verified identity');
const minted = new WeakSet<object>();

// Minted only by the OIDC and SAML verifiers inside this package, from a response whose
// signature and state they already checked. Nothing outside can hand in a claimed identity.
export interface VerifiedIdentity {
  readonly [verified]: true;
  readonly protocol: SsoProtocol;
  readonly organizationId: OrganizationId;
  readonly connectionId: SsoConnectionId;
  // OIDC sub or SAML persistent NameID.
  readonly subject: string;
  // Normalized; the verifier already held it to the connection's verified domains.
  readonly email: string;
  readonly displayName: string | null;
  // auth_time or AuthnInstant, never in the future and never more than a day old.
  readonly idpAuthenticatedAt: Date;
}

export const SUBJECT_MAX = 255;
export const DISPLAY_NAME_MAX = 120;
const DAY_MS = 86_400_000;

// C0, DEL and C1. A subject with one is refused: Postgres text cannot hold NUL, and nothing
// a real IdP sends needs the others. A display name has them removed.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

const codePoints = (value: string) => Array.from(value).length;

const CLAIMS = z.strictObject({
  protocol: z.enum(['oidc', 'saml']),
  organizationId: z.string(),
  connectionId: z.string(),
  subject: z
    .string()
    .refine((s) => codePoints(s) >= 1 && codePoints(s) <= SUBJECT_MAX && !CONTROL.test(s)),
  email: z.string(),
  displayName: z.string().nullable(),
  idpAuthenticatedAt: z.date().refine((d) => !Number.isNaN(d.getTime())),
});

export type IdentityClaims = z.input<typeof CLAIMS>;

// Control characters out, outer space trimmed, then cut by code point so a surrogate pair is
// never split. Empty means no name.
export function cleanDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const chars = Array.from(value.replace(CONTROLS, '').trim()).slice(0, DISPLAY_NAME_MAX);
  const name = chars.join('').trim();
  return name === '' ? null : name;
}

export function clampAuthenticatedAt(at: Date, now: Date): Date {
  const time = Math.min(Math.max(at.getTime(), now.getTime() - DAY_MS), now.getTime());
  return new Date(time);
}

// Null when a claim is outside its limits: a subject that is empty, too long or holds a
// control character, an address that does not normalize, an id that is not one, or a time
// that is not a time. The caller answers that with one refusal and logs no claim.
export function mintVerifiedIdentity(
  claims: IdentityClaims,
  now: Date = new Date(),
): VerifiedIdentity | null {
  const parsed = CLAIMS.safeParse(claims);
  if (!parsed.success) return null;
  const c = parsed.data;
  const organizationId = asId('org', c.organizationId);
  const connectionId = asId('ssc', c.connectionId);
  const email = normalizeAddress(c.email);
  if (organizationId === null || connectionId === null || email === null) return null;
  const identity: VerifiedIdentity = Object.freeze({
    [verified]: true as const,
    protocol: c.protocol,
    organizationId,
    connectionId,
    subject: c.subject,
    email,
    displayName: cleanDisplayName(c.displayName),
    idpAuthenticatedAt: clampAuthenticatedAt(c.idpAuthenticatedAt, now),
  });
  minted.add(identity);
  return identity;
}

// True only for an identity this module made, whatever its shape says.
export function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  return typeof value === 'object' && value !== null && minted.has(value);
}
