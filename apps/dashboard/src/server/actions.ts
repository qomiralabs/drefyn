import { checkFormBinding, type BrowserContext } from '@drefyn/auth';
import { cookies, headers } from 'next/headers';
import { createWrappers } from './action-wrappers.ts';
import { authConfig } from './auth.ts';
import { readClientAddress } from './client-address.ts';
import { requireDashboardForVisitor } from './gate.ts';
import { guardOrganization, guardSession } from './guard.ts';
import { logWarn } from './log.ts';
import { appOrigin } from './origin.ts';
import { clientIpWrapperRunning } from './wrapper-marker.ts';

// What a signed out GET route knows of its browser, resolved as the wrappers resolve it, or
// null when the client IP wrapper is not in front.
export async function visitorBrowser(): Promise<BrowserContext | null> {
  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  const address = readClientAddress(requestHeaders, clientIpWrapperRunning());
  if (!address.ok) return null;
  return {
    ip: address.ip,
    userAgent: (requestHeaders.get('user-agent') ?? '').slice(0, 256),
    cookies: new Map(requestCookies.getAll().map(({ name, value }) => [name, value])),
  };
}

export const { publicAction, signedInAction, orgAction, publicRoute, signedInRoute, orgRoute } =
  createWrappers({
    appOrigin,
    request: async () => {
      const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
      return {
        headers: new Headers(requestHeaders),
        cookies: new Map(requestCookies.getAll().map(({ name, value }) => [name, value])),
      };
    },
    wrapperRunning: clientIpWrapperRunning,
    visitorFlag: requireDashboardForVisitor,
    checkBinding: (browser, field) => checkFormBinding(authConfig(), browser, field),
    session: guardSession,
    organization: guardOrganization,
    now: Date.now,
    logWarn,
  });
