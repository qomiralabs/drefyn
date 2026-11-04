// Every state the gallery draws, by screen. A name here that it lacks fails as a 404.
export const AUTH_STATES: Readonly<Record<string, readonly string[]>> = {
  'sign-in': [
    'ready',
    'email-only',
    'invalid',
    'unavailable',
    'limited',
    'expired',
    'oauth-error',
    'oauth-unverified',
    'none',
  ],
  'sign-up': ['ready', 'closed', 'invite-only', 'botcheck-down'],
  verify: ['ready', 'wrong', 'expired', 'link', 'elsewhere', 'reading', 'choose-password'],
  password: ['ready', 'wrong', 'limited', 'botcheck-down'],
  reset: ['ask', 'code', 'choose', 'refused', 'breached', 'saved'],
  link: ['ready', 'wrong'],
  cli: ['invalid', 'failed'],
  welcome: [
    'ready',
    'invited',
    'email-only',
    'name',
    'password',
    'breached',
    'late',
    'failed',
    'half-saved',
  ],
  organization: [
    'ready',
    'name',
    'limited',
    'failed',
    'invited',
    'another',
    'none',
    'none-invited',
  ],
  invite: ['reading', 'signed-out', 'match', 'mismatch', 'invalid', 'failed'],
  block: ['reading', 'ask', 'done', 'invalid', 'failed'],
};

export const authStatePaths = (): readonly (readonly [string, string])[] =>
  Object.entries(AUTH_STATES).flatMap(([screen, states]) =>
    states.map((state) => [`${screen}-${state}`, `/auth-states/${screen}/${state}`] as const),
  );

export const SELF_HOSTED = '/auth-states/sign-in/ready?host=self';
