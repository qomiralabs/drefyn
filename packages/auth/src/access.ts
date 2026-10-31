import { PRODUCTS, TIERS, type Product, type Tier } from '@drefyn/entitlements';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import {
  ORG_ROLES,
  permissionsFor,
  type OrgRole,
  type Permission,
  type ProjectRole,
} from './permissions.ts';
import type { SessionId } from './session-support.ts';

// Not exported, so nothing outside this package can build an AccessContext without a cast,
// and a data function that takes one cannot be reached without the guard.
declare const accessBrand: unique symbol;

export interface AccessContext {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly role: OrgRole;
  readonly tier: Tier;
  readonly authenticatedAt: Date;
  readonly permissions: readonly Permission[];
  readonly [accessBrand]: true;
}

export type AccessResult =
  // touchDue: run touchSession after the response.
  | { readonly kind: 'ok'; readonly access: AccessContext; readonly touchDue: boolean }
  | { readonly kind: 'signed_out' }
  // The same answer for an unknown slug, so the guard's 404 says nothing about which.
  | { readonly kind: 'not_member' };

const KNOWN_TIERS: ReadonlyMap<unknown, Tier> = new Map(TIERS.map((t) => [t, t]));
const KNOWN_ROLES: ReadonlyMap<unknown, OrgRole> = new Map(ORG_ROLES.map((r) => [r, r]));
const DEFAULT_PROJECT_ROLES: ReadonlyMap<unknown, ProjectRole> = new Map([
  ['editor', 'editor'],
  ['viewer', 'viewer'],
]);
const EVERY_PRODUCT: ReadonlySet<Product> = new Set(PRODUCTS);
const NO_PRODUCT: ReadonlySet<Product> = new Set();

// Stored values the database checks already hold to these lists. A value outside them means
// the schema and this code disagree, which is a fault, not a person to let in.
export function storedTier(value: unknown): Tier {
  const tier = KNOWN_TIERS.get(value);
  if (tier === undefined) throw new Error('stored plan tier is unknown');
  return tier;
}

export function storedRole(value: unknown): OrgRole {
  const role = KNOWN_ROLES.get(value);
  if (role === undefined) throw new Error('stored organization role is unknown');
  return role;
}

function storedDefaultRole(value: unknown): ProjectRole | null {
  if (value === null) return null;
  const role = DEFAULT_PROJECT_ROLES.get(value);
  if (role === undefined) throw new Error('stored default project role is unknown');
  return role;
}

// Owners and admins are project admins everywhere. A member with a default project role
// holds it on every project of every product; one without holds none until a project role
// is granted to them.
function productReach(role: OrgRole, defaultRole: ProjectRole | null): ReadonlySet<Product> {
  if (role !== 'member') return EVERY_PRODUCT;
  return defaultRole === null ? NO_PRODUCT : EVERY_PRODUCT;
}

export interface AccessFacts {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly role: unknown;
  readonly defaultProjectRole: unknown;
  readonly tier: unknown;
  readonly authenticatedAt: Date;
}

export function grantAccess(facts: AccessFacts): AccessContext {
  const role = storedRole(facts.role);
  const reach = productReach(role, storedDefaultRole(facts.defaultProjectRole));
  return Object.freeze({
    organizationId: facts.organizationId,
    userId: facts.userId,
    sessionId: facts.sessionId,
    role,
    tier: storedTier(facts.tier),
    authenticatedAt: facts.authenticatedAt,
    permissions: permissionsFor(role, reach),
  }) as AccessContext;
}
