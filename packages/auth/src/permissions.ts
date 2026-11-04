// Loaded by client components to decide what to show, so it imports types only. Every
// server action and route handler checks again on the server.
import type { Product } from '@drefyn/entitlements';

export type OrgRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'admin' | 'editor' | 'viewer';

// Most to least powerful; the order is what canAssign compares.
export const ORG_ROLES: readonly OrgRole[] = Object.freeze(['owner', 'admin', 'member']);
export const PROJECT_ROLES: readonly ProjectRole[] = Object.freeze(['admin', 'editor', 'viewer']);

export const PERMISSIONS = Object.freeze([
  'org.read',
  'org.manage_members',
  'org.manage_api_keys',
  'org.manage_settings',
  'org.manage_billing',
  'org.delete',
  'project.create',
  'docs.read',
  'studio.read',
  'status.read',
] as const);

export type Permission = (typeof PERMISSIONS)[number];

type OrgPermission = Exclude<Permission, `${Product}.read`>;

const MEMBER: readonly OrgPermission[] = ['org.read'];
const ADMIN: readonly OrgPermission[] = [
  ...MEMBER,
  'org.manage_members',
  'org.manage_api_keys',
  'org.manage_settings',
  'project.create',
];
// Only owners touch money and the organization's existence.
const OWNER: readonly OrgPermission[] = [...ADMIN, 'org.manage_billing', 'org.delete'];

const BY_ROLE: Readonly<Record<OrgRole, readonly OrgPermission[]>> = {
  owner: OWNER,
  admin: ADMIN,
  member: MEMBER,
};

const PRODUCT_READ: Readonly<Record<Product, Permission>> = {
  docs: 'docs.read',
  studio: 'studio.read',
  status: 'status.read',
};

const isRole = (value: unknown): value is OrgRole =>
  typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);

// productReach is the set of products the person may open: the organization's products
// for owners and admins, the products they hold a project role in for members. The
// caller decides that, so this stays a pure function of what it is given.
export function permissionsFor(
  role: OrgRole,
  productReach: ReadonlySet<Product>,
): readonly Permission[] {
  if (!isRole(role)) throw new TypeError('unknown organization role');
  const granted = new Set<Permission>(BY_ROLE[role]);
  for (const product of productReach) {
    const read = Object.hasOwn(PRODUCT_READ, product) ? PRODUCT_READ[product] : undefined;
    if (read === undefined) throw new TypeError('unknown product');
    granted.add(read);
  }
  return Object.freeze(PERMISSIONS.filter((p) => granted.has(p)));
}

// Owners assign any role; admins assign admin and member, never owner; members assign
// nothing. An unknown role on either side is a refusal, not a guess.
export function canAssign(actor: OrgRole, target: OrgRole): boolean {
  if (!isRole(actor) || !isRole(target)) return false;
  if (actor === 'member') return false;
  return ORG_ROLES.indexOf(actor) <= ORG_ROLES.indexOf(target);
}

// The person acting, and whether the membership they act on is their own.
export interface RoleActor {
  readonly role: OrgRole;
  readonly self: boolean;
}

const rank = (role: OrgRole) => ORG_ROLES.length - ORG_ROLES.indexOf(role);

// Owners set any role on anyone else; admins move admins and members between the two and
// never touch an owner; members change nothing. Nobody raises their own role.
export function canChangeRole(actor: RoleActor, from: OrgRole, to: OrgRole): boolean {
  if (!isRole(actor.role) || !isRole(from) || !isRole(to)) return false;
  if (actor.role === 'member') return false;
  if (actor.self && rank(to) > rank(from)) return false;
  if (actor.role === 'admin' && (from === 'owner' || to === 'owner')) return false;
  return true;
}

// Owners remove anyone else; admins remove admins and members. Leaving is its own flow, so
// nobody removes themselves here.
export function canRemove(actor: RoleActor, target: OrgRole): boolean {
  if (!isRole(actor.role) || !isRole(target)) return false;
  if (actor.self || actor.role === 'member') return false;
  return actor.role === 'owner' || target !== 'owner';
}
