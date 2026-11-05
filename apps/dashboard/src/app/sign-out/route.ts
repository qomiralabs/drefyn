import { serializeCookie } from '@drefyn/auth';
import { dashboardAuth, authConfig } from '../../server/auth.ts';
import { signedInRoute } from '../../server/actions.ts';
import { appUrl } from '../../server/origin.ts';

export const POST = signedInRoute(async ({ session }) => {
  const auth = await dashboardAuth();
  const cleared = await auth.sessions.signOut(session);
  const config = authConfig();
  // No Clear-Site-Data: it would wipe the known device cookie, which keeps the person's own
  // browser out of the address ceiling, and in Chromium every cookie on sibling hosts too.
  const headers = new Headers({ location: appUrl('/sign-in').href, 'cache-control': 'no-store' });
  for (const spec of cleared) headers.append('set-cookie', serializeCookie(config, spec));
  return new Response(null, { status: 303, headers });
});
