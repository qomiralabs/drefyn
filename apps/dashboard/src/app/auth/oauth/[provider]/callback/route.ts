import { safeReturnTo, serializeCookie, type AuthErrorCode } from '@drefyn/auth';
import { after, NextResponse, type NextRequest } from 'next/server';
import { authConfig, dashboardAuth } from '../../../../../server/auth.ts';
import { visitorBrowser } from '../../../../../server/actions.ts';
import { guardPublic } from '../../../../../server/guard.ts';
import { appOrigin, appUrl } from '../../../../../server/origin.ts';

interface Context {
  readonly params: Promise<{ readonly provider: string }>;
}

function errorName(code: AuthErrorCode): string {
  if (code === 'AUTH_OAUTH_EMAIL_UNVERIFIED') return 'unverified';
  if (code === 'AUTH_SIGNUP_CLOSED') return 'closed';
  return code === 'AUTH_OAUTH_STATE_INVALID' ? 'state' : 'provider';
}

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  await guardPublic();
  const { provider } = await context.params;
  if (provider !== 'github' && provider !== 'google') {
    return new Response(null, { status: 404 });
  }
  const refuse = (error: string) =>
    NextResponse.redirect(appUrl(`/sign-in?error=${error}&provider=${provider}`), 303);
  const browser = await visitorBrowser();
  if (browser === null) return refuse('provider');
  const auth = await dashboardAuth();
  const done = await auth.oauth.completeOAuth(browser, {
    provider,
    query: request.nextUrl.searchParams,
  });
  if (!done.ok) return refuse(errorName(done.error.code));
  const outcome = done.value;
  const target =
    outcome.kind === 'link_pending'
      ? appUrl('/sign-in/link')
      : appUrl(safeReturnTo(outcome.returnTo, appOrigin()));
  const response = NextResponse.redirect(target, 303);
  const config = authConfig();
  for (const spec of outcome.setCookies) {
    response.headers.append('set-cookie', serializeCookie(config, spec));
  }
  if ('send' in outcome && outcome.send !== undefined) after(outcome.send);
  return response;
}
