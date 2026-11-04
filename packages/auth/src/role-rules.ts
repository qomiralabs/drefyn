import type { AuthErrorCode } from './errors.ts';
import { canAssign, canChangeRole, canRemove, type OrgRole } from './permissions.ts';

// What the code decides under the organization lock, as one pure function each, so the
// property tests run the same decision over a model organization.

export interface RoleChangeFacts {
  readonly actorRole: OrgRole;
  readonly self: boolean;
  readonly from: OrgRole;
  readonly to: OrgRole;
  // Owners other than the membership being changed, read after the lock.
  readonly otherOwners: number;
}

export type RoleRefusal = Extract<AuthErrorCode, 'AUTH_FORBIDDEN' | 'AUTH_LAST_OWNER'>;

// Authority first, so someone who may not make the change never learns about the owners.
export function roleChangeRefusal(f: RoleChangeFacts): RoleRefusal | null {
  if (!canChangeRole({ role: f.actorRole, self: f.self }, f.from, f.to)) return 'AUTH_FORBIDDEN';
  if (f.from === 'owner' && f.to !== 'owner' && f.otherOwners < 1) return 'AUTH_LAST_OWNER';
  return null;
}

export interface RemovalFacts {
  readonly actorRole: OrgRole;
  readonly self: boolean;
  readonly target: OrgRole;
  readonly otherOwners: number;
}

export function removalRefusal(f: RemovalFacts): RoleRefusal | null {
  if (!canRemove({ role: f.actorRole, self: f.self }, f.target)) return 'AUTH_FORBIDDEN';
  if (f.target === 'owner' && f.otherOwners < 1) return 'AUTH_LAST_OWNER';
  return null;
}

// Every live key answers to an owner or admin, the rule the database checks at creation.
export const keysGoWith = (to: OrgRole): boolean => to === 'member';

// The invitation roles the new role can no longer grant. Acceptance would refuse them
// anyway; deleting them frees their seats.
export function invitationRolesLost(to: OrgRole): readonly OrgRole[] {
  return (['owner', 'admin', 'member'] as const).filter((role) => !canAssign(to, role));
}
