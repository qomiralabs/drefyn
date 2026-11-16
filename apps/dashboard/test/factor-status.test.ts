import { AuthError } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.fn();
const isOn = vi.fn<() => Promise<unknown>>();
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ secondFactors: { status } }),
}));
vi.mock('../src/server/flags.ts', () => ({ totpFlag: { isOn } }));

const { factorFacts } = await import('../src/server/factor-status.ts');
const SESSION = { userId: 'usr_1' } as unknown as Parameters<typeof factorFacts>[0];
const STATUS = { available: true, enrolled: true, recoveryCodesLeft: 7 };

beforeEach(() => {
  status.mockReset();
  isOn.mockReset();
});

describe('factorFacts', () => {
  it('passes the status through', async () => {
    status.mockResolvedValue({ ok: true, value: STATUS });
    expect(await factorFacts(SESSION)).toEqual(STATUS);
    expect(isOn).not.toHaveBeenCalled();
  });

  it('says the read failed where enrolment is released', async () => {
    status.mockResolvedValue({ ok: false, error: new AuthError('AUTH_UNAVAILABLE') });
    isOn.mockResolvedValue(true);
    expect(await factorFacts(SESSION)).toBe('failed');
  });

  // An outage must not show a row for a feature that is still off.
  it.each([false, 'true', new Error('flagd')])(
    'shows nothing when the flag is %s',
    async (flag) => {
      status.mockResolvedValue({ ok: false, error: new AuthError('AUTH_UNAVAILABLE') });
      if (flag instanceof Error) isOn.mockRejectedValue(flag);
      else isOn.mockResolvedValue(flag);
      expect(await factorFacts(SESSION)).toBeNull();
    },
  );
});
