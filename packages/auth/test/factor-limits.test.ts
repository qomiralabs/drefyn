import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  FACTOR_RATE_SCOPES,
  RATE_BUCKETS,
  factorNoticeLimit,
  factorVerifyLimits,
  parseAuthConfig,
} from '../src/index.ts';
import { UUID_A, UUID_B, validEnv } from './support.ts';

const ALICE = userId(UUID_A);
const BOB = userId(UUID_B);
const IP = '203.0.113.7';
const IP6 = '2001:db8:1:2:3:4:5:6';

describe('second factor rate buckets', () => {
  it('lists each bucket with the key it is counted by', () => {
    expect(FACTOR_RATE_SCOPES).toEqual({
      totp_verify: 'person',
      recovery_code_verify: 'person_and_network',
      recovery_code_verify_ip: 'network',
      second_factor_notice: 'person',
    });
    for (const bucket of Object.keys(FACTOR_RATE_SCOPES)) expect(RATE_BUCKETS).toContain(bucket);
    expect(Object.isFrozen(FACTOR_RATE_SCOPES)).toBe(true);
  });

  it('defaults to the limits in the config table, each with its own key', () => {
    const config = parseAuthConfig(validEnv());
    expect({
      totp_verify: config.rateLimits.totp_verify,
      recovery_code_verify: config.rateLimits.recovery_code_verify,
      recovery_code_verify_ip: config.rateLimits.recovery_code_verify_ip,
      second_factor_notice: config.rateLimits.second_factor_notice,
    }).toEqual({
      totp_verify: [
        { count: 5, windowSeconds: 300 },
        { count: 20, windowSeconds: 3600 },
        { count: 50, windowSeconds: 86_400 },
      ],
      recovery_code_verify: [{ count: 10, windowSeconds: 3600 }],
      recovery_code_verify_ip: [{ count: 30, windowSeconds: 3600 }],
      second_factor_notice: [{ count: 1, windowSeconds: 21_600 }],
    });
    const tuned = parseAuthConfig({
      ...validEnv(),
      DREFYN_AUTH_RATE_TOTP_VERIFY: '3/5m',
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY: '5/1h',
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY_IP: '20/1h',
      DREFYN_AUTH_RATE_SECOND_FACTOR_NOTICE: '1/12h',
    });
    expect(tuned.rateLimits.totp_verify).toEqual([{ count: 3, windowSeconds: 300 }]);
    expect(tuned.rateLimits.recovery_code_verify).toEqual([{ count: 5, windowSeconds: 3600 }]);
    expect(tuned.rateLimits.recovery_code_verify_ip).toEqual([{ count: 20, windowSeconds: 3600 }]);
    expect(tuned.rateLimits.second_factor_notice).toEqual([{ count: 1, windowSeconds: 43_200 }]);
  });

  it('counts TOTP on the person alone, so rotating networks gains nothing', () => {
    expect(factorVerifyLimits('totp', { userId: ALICE, ip: IP })).toEqual([
      { bucket: 'totp_verify', value: [UUID_A] },
    ]);
    expect(factorVerifyLimits('totp', { userId: ALICE, ip: IP6 })).toEqual(
      factorVerifyLimits('totp', { userId: ALICE, ip: IP }),
    );
  });

  // Someone elsewhere must never be able to fill the owner's recovery budget.
  it('gives recovery codes no person wide ceiling', () => {
    const limits = factorVerifyLimits('recovery_code', { userId: ALICE, ip: IP });
    expect(limits).toEqual([
      { bucket: 'recovery_code_verify', value: [UUID_A, 'ip4:203.0.113.7'] },
      { bucket: 'recovery_code_verify_ip', value: ['ip4:203.0.113.7'] },
    ]);
    for (const { bucket, value } of limits) {
      expect(FACTOR_RATE_SCOPES[bucket as keyof typeof FACTOR_RATE_SCOPES]).not.toBe('person');
      expect(value.some((part) => typeof part === 'string' && part.startsWith('ip'))).toBe(true);
    }
    // Another network for the same person is a separate budget.
    const elsewhere = factorVerifyLimits('recovery_code', { userId: ALICE, ip: IP6 });
    expect(elsewhere[0]?.value).toEqual([UUID_A, 'ip6:2001:0db8:0001:0002::/64']);
    expect(elsewhere[0]?.value).not.toEqual(limits[0]?.value);
  });

  it('caps the failure notice per person', () => {
    expect(factorNoticeLimit(ALICE)).toEqual({ bucket: 'second_factor_notice', value: [UUID_A] });
    expect(factorNoticeLimit(BOB)).not.toEqual(factorNoticeLimit(ALICE));
  });

  it('refuses an address it cannot key', () => {
    expect(() => factorVerifyLimits('recovery_code', { userId: ALICE, ip: 'nope' })).toThrow(
      expect.objectContaining({ code: 'AUTH_INPUT_INVALID' }),
    );
  });
});
