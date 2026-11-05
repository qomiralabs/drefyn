import { serializeCookie } from '@drefyn/auth';
import { dashboardAuth, authConfig } from '../../server/auth.ts';
import { signedInRoute } from '../../server/actions.ts';
import { appUrl } from '../../server/origin.ts';
import { withSignOutHeaders } from '../../server/security-headers.ts';

export const POST = signedInRoute(async ({ session }) => {
  const auth = await dashboardAuth();
  const cleared = await auth.sessions.signOut(session);
  const config = authConfig();
  const headers = new Headers({ location: appUrl('/sign-in').href });
  for (const spec of cleared) headers.append('set-cookie', serializeCookie(config, spec));
  return withSignOutHeaders(new Response(null, { status: 303, headers }));
});
