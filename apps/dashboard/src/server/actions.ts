import { checkFormBinding } from '@drefyn/auth';
import { cookies, headers } from 'next/headers';
import { createWrappers } from './action-wrappers.ts';
import { authConfig } from './auth.ts';
import { requireDashboardForVisitor } from './gate.ts';
import { guardOrganization, guardSession } from './guard.ts';
import { logWarn } from './log.ts';
import { appOrigin } from './origin.ts';
import { clientIpWrapperRunning } from './wrapper-marker.ts';

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
