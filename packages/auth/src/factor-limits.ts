import type { UserId } from '@drefyn/tenancy';
import { rateKeyForIp } from './client-ip.ts';
import type { RateBucket } from './config-keys.ts';
import type { MacPart } from './keys.ts';
import type { FactorKind } from './totp.ts';

export type FactorBucket =
  'totp_verify' | 'recovery_code_verify' | 'recovery_code_verify_ip' | 'second_factor_notice';
export type FactorRateScope = 'person' | 'person_and_network' | 'network';

// What each bucket is counted by. TOTP is keyed on the person alone because it is what
// bounds guessing six digits. Recovery codes carry 120 bits, so their limit only caps work,
// and keying it on the network too means nobody elsewhere can fill the owner's budget.
export const FACTOR_RATE_SCOPES: Readonly<Record<FactorBucket, FactorRateScope>> = Object.freeze({
  totp_verify: 'person',
  recovery_code_verify: 'person_and_network',
  recovery_code_verify_ip: 'network',
  second_factor_notice: 'person',
});

export interface RateReservation {
  readonly bucket: RateBucket;
  readonly value: readonly MacPart[];
}

export interface FactorAttempt {
  readonly userId: UserId;
  readonly ip: string;
}

// The reservations one attempt makes, in order, before anything is decrypted or compared.
export function factorVerifyLimits(
  kind: FactorKind,
  who: FactorAttempt,
): readonly RateReservation[] {
  if (kind === 'totp') return [{ bucket: 'totp_verify', value: [who.userId] }];
  const network = rateKeyForIp(who.ip);
  return [
    { bucket: 'recovery_code_verify', value: [who.userId, network] },
    { bucket: 'recovery_code_verify_ip', value: [network] },
  ];
}

export function factorNoticeLimit(userId: UserId): RateReservation {
  return { bucket: 'second_factor_notice', value: [userId] };
}
