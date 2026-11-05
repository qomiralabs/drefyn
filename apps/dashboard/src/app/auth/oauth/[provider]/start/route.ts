import { serializeCookie } from '@drefyn/auth';
import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, dashboardAuth } from '../../../../../server/auth.ts';
import { visitorBrowser } from '../../../../../server/actions.ts';
import { currentSession, guardPublic } from '../../../../../server/guard.ts';
import { appUrl, requestQuery, sameOriginNavigation } from '../../../../../server/origin.ts';

interface Context {
  readonly params: Promise<{ readonly provider: string }>;
}

// A plain link, not a form: form-action 'self' would stop a post whose redirect leaves here.
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  await guardPublic();
  const { provider } = await context.params;
  if (provider !== 'github' && provider !== 'google') {
    return new Response(null, { status: 404 });
  }
  const failed = appUrl(`/sign-in?error=provider&provider=${provider}`);
  const browser = await visitorBrowser();
  if (browser === null) return NextResponse.redirect(failed, 303);
  const query = requestQuery(request);
  const next = query.get('next');
  const purpose =
    query.get('purpose') === 'link' || query.get('purpose') === 'step_up'
      ? (query.get('purpose') as 'link' | 'step_up')
      : 'sign_in';
  // Both act for the person in this browser, whose lax cookie comes along on a link from any
  // site. A provider can answer with no prompt, so a lure must not get to start them.
  if (purpose !== 'sign_in' && !sameOriginNavigation(request.headers)) {
    return NextResponse.redirect(appUrl('/account/sign-in?error=provider'), 303);
  }
  const session = purpose === 'sign_in' ? null : await currentSession();
  if (purpose !== 'sign_in' && session === null) return NextResponse.redirect(failed, 303);
  const auth = await dashboardAuth();
  const started = await auth.oauth.startOAuth(browser, {
    provider,
    purpose,
    ...(next === null ? {} : { returnTo: next }),
    ...(session === null ? {} : { session }),
  });
  if (!started.ok) {
    return NextResponse.redirect(
      purpose === 'sign_in' ? failed : appUrl('/account/sign-in?error=provider'),
      303,
    );
  }
  const response = NextResponse.redirect(started.value.redirectTo, 302);
  const config = authConfig();
  for (const spec of started.value.setCookies) {
    response.headers.append('set-cookie', serializeCookie(config, spec));
  }
  return response;
}
