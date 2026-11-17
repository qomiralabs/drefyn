import { serializeCookie, type AuthError, type CookieSpec } from '@drefyn/auth';
import { after } from 'next/server';
import { minutesLeft } from '../auth/outcomes.ts';
import type { FactorProblem } from '../settings/factor-words.ts';
import { readForm, type RouteRequest, type SignedInContext } from './action-wrappers.ts';
import { authConfig, dashboardAuth } from './auth.ts';
import { codesPage, enrolPage, SETTINGS_PATH } from './factor-page.ts';
import { totpFlag } from './flags.ts';
import { appUrl } from './origin.ts';
import { failureReference } from './sign-in-support.ts';

// Enrolment and fresh recovery codes are answered by these POST handlers alone, never by a
// Server Action: a Server Action writes its returned state into the page payload, and a
// secret or a code must appear in the response exactly once, where the person reads it.
// A refusal never carries either, so it goes back to settings with a closed word.

const NO_STORE = 'no-store';

function html(body: string, cookies: readonly CookieSpec[] = []): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': NO_STORE,
  });
  const config = authConfig();
  for (const spec of cookies) headers.append('set-cookie', serializeCookie(config, spec));
  return new Response(body, { status: 200, headers });
}

function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: appUrl(path).href, 'cache-control': NO_STORE },
  });
}

const bare = (status: 404 | 413) =>
  new Response(null, { status, headers: { 'cache-control': NO_STORE } });

// Where a refusal sends the person, by the closed code the library gave.
export function refusalPath(error: Pick<AuthError, 'code' | 'retryAfterSeconds'>, event: string) {
  const back = (problem: FactorProblem, extra = '') => `${SETTINGS_PATH}?factor=${problem}${extra}`;
  switch (error.code) {
    case 'AUTH_SESSION_INVALID':
      return '/sign-in';
    case 'AUTH_RECENT_AUTH_REQUIRED':
      return back('confirm');
    case 'AUTH_FACTOR_INVALID':
      return back('wrong');
    case 'AUTH_FACTOR_DISABLED':
      return back('disabled');
    case 'AUTH_RATE_LIMITED':
      return back('limited', `&retry=${String(minutesLeft(error.retryAfterSeconds))}`);
    case 'AUTH_FACTOR_CHALLENGE_EXPIRED':
      return back('expired');
    case 'AUTH_FACTOR_ALREADY_ENROLLED':
      return back('enrolled');
    case 'AUTH_FACTOR_NOT_ENROLLED':
      return back('not_enrolled');
    default:
      return back('failed', `&ref=${failureReference(event)}`);
  }
}

// The flag gates enrolment and its screens. Off reads as not there at all. A throw is off.
async function enrolmentOn(context: SignedInContext): Promise<boolean> {
  try {
    const value: unknown = await totpFlag.isOn('auth.totp', { userId: context.session.userId });
    return value === true;
  } catch {
    return false;
  }
}

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

// The wrapper has already checked the Origin and the session. Then the flag, then the body
// cap, and only then the library, which runs its own step up checks before sealing anything.
async function admitted(
  context: SignedInContext,
  request: RouteRequest,
): Promise<FormData | Response> {
  if (!(await enrolmentOn(context))) return bare(404);
  const form = await readForm(request);
  return form instanceof FormData ? form : bare(413);
}

export async function startEnrolment(
  context: SignedInContext,
  request: RouteRequest,
): Promise<Response> {
  const form = await admitted(context, request);
  if (form instanceof Response) return form;
  const auth = await dashboardAuth();
  const started = await auth.secondFactors.startEnrollment(context.browser, context.session);
  if (!started.ok) {
    if (started.error.code === 'AUTH_NOT_FOUND') return bare(404);
    return seeOther(refusalPath(started.error, 'settings.factor_start_failed'));
  }
  return html(enrolPage({ ...started.value, mistyped: false }));
}

export async function confirmEnrolment(
  context: SignedInContext,
  request: RouteRequest,
): Promise<Response> {
  const form = await admitted(context, request);
  if (form instanceof Response) return form;
  const auth = await dashboardAuth();
  const done = await auth.secondFactors.confirmEnrollment(context.browser, context.session, {
    code: field(form, 'code'),
  });
  if (!done.ok) {
    if (done.error.code === 'AUTH_NOT_FOUND') return bare(404);
    return seeOther(refusalPath(done.error, 'settings.factor_confirm_failed'));
  }
  const { value } = done;
  // Only a code that was checked and did not match may show the pending secret again.
  if (value.kind === 'mistyped') return html(enrolPage({ ...value.enrollment, mistyped: true }));
  after(value.send);
  return html(
    codesPage({ recoveryCodes: value.recoveryCodes, reason: 'enrolled' }),
    value.setCookies,
  );
}

export async function replaceCodes(
  context: SignedInContext,
  request: RouteRequest,
): Promise<Response> {
  const form = await admitted(context, request);
  if (form instanceof Response) return form;
  const auth = await dashboardAuth();
  const done = await auth.secondFactors.replaceRecoveryCodes(context.browser, context.session, {
    kind: field(form, 'kind') === 'recovery_code' ? 'recovery_code' : 'totp',
    code: field(form, 'code'),
  });
  if (!done.ok) return seeOther(refusalPath(done.error, 'settings.factor_replace_failed'));
  after(done.value.send);
  return html(
    codesPage({ recoveryCodes: done.value.recoveryCodes, reason: 'replaced' }),
    done.value.setCookies,
  );
}
