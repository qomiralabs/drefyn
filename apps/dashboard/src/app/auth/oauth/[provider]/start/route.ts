import { serializeCookie } from '@drefyn/auth';
import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, dashboardAuth } from '../../../../../server/auth.ts';
import { visitorBrowser } from '../../../../../server/actions.ts';
import { guardPublic } from '../../../../../server/guard.ts';
import { appUrl, requestQuery } from '../../../../../server/origin.ts';

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
  const next = requestQuery(request).get('next');
  const auth = await dashboardAuth();
  const started = await auth.oauth.startOAuth(browser, {
    provider,
    purpose: 'sign_in',
    ...(next === null ? {} : { returnTo: next }),
  });
  if (!started.ok) return NextResponse.redirect(failed, 303);
  const response = NextResponse.redirect(started.value.redirectTo, 302);
  const config = authConfig();
  for (const spec of started.value.setCookies) {
    response.headers.append('set-cookie', serializeCookie(config, spec));
  }
  return response;
}
