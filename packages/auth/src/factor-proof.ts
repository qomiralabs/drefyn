import type { UserId } from '@drefyn/tenancy';
import type { FactorKind } from './totp.ts';

declare const proved: unique symbol;

// That a person just passed their second factor. Only the factor check mints one, the
// package entry never exports it, and each is good for one session for that person alone.
export interface FactorProof {
  readonly [proved]: true;
  readonly userId: UserId;
  readonly kind: FactorKind;
}

// Held by identity, so a copy of a proof's fields proves nothing.
const live = new WeakSet<object>();

export function mintFactorProof(userId: UserId, kind: FactorKind): FactorProof {
  const proof = Object.freeze({ userId, kind }) as unknown as FactorProof;
  live.add(proof);
  return proof;
}

// True once, for a proof minted here for this person. Spent either way it is asked about,
// so a proof handed to the wrong person cannot be tried again for the right one.
export function spendFactorProof(proof: unknown, userId: UserId): boolean {
  if (typeof proof !== 'object' || proof === null || !live.has(proof)) return false;
  live.delete(proof);
  return (proof as FactorProof).userId === userId;
}
