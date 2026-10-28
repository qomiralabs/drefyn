export interface CookieNames {
  readonly session: string;
  readonly pre: string;
  readonly oauth: string;
  readonly invite: string;
}

// Browsers refuse the __Host- prefix without Secure, so the plain http loopback setup
// gets the bare names.
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return Object.freeze({
    session: `${prefix}drefyn_session`,
    pre: `${prefix}drefyn_pre`,
    oauth: `${prefix}drefyn_oauth`,
    invite: `${prefix}drefyn_invite`,
  });
}
