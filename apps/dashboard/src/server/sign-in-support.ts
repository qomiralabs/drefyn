import { randomBytes } from 'node:crypto';
import {
  decodeSecret,
  encodeSecret,
  formBindingField,
  lastMethodCookie,
  parseLastMethod,
  type LastMethod,
  PRE_MAX_AGE_SECONDS,
  safeReturnTo,
  type CookieSpec,
  type SessionInfo,
} from '@drefyn/auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { preRedirect } from '../auth/pre-target.ts';
import type { Site } from '../auth/site.ts';
import { authConfig } from './auth.ts';
import { docsUrl } from './docs-url.ts';
import { arrival } from './first-run.ts';
import { logWarn } from './log.ts';
import { appOrigin } from './origin.ts';

const PRE_SECRET_BYTES = 32;

export async function applyCookies(specs: readonly CookieSpec[]): Promise<void> {
  const jar = await cookies();
  const secure = authConfig().cookieSecure;
  for (const { name, value, maxAgeSeconds } of specs) {
    jar.set({
      name,
      value,
      maxAge: maxAgeSeconds,
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
    });
  }
}

// Ties what a person reads to one log line, and says nothing itself.
export function failureReference(event: string): string {
  const reference = `ref_${randomBytes(6).toString('hex')}`;
  logWarn(event, { reference });
  return reference;
}

export interface Finished {
  readonly setCookies: readonly CookieSpec[];
  readonly returnTo: string;
  readonly send?: () => Promise<void>;
  // Who signed in, when the caller knows: a first sign in stops at Welcome on its way.
  readonly session?: SessionInfo;
}

// Sign in clears the pre sign in cookie, and the invitation page still posts a bound form. A
// page cannot mint one in the middle of an action's redirect, so a new secret goes out now.
// It is new, so nothing chosen before sign in survives.
export function freshBinding(returnTo: string): readonly CookieSpec[] {
  if (!returnTo.startsWith('/invite')) return [];
  const value = encodeSecret(randomBytes(PRE_SECRET_BYTES));
  return [{ name: authConfig().cookies.pre, value, maxAgeSeconds: PRE_MAX_AGE_SECONDS }];
}

// Cookies, then the mail after the response, then the page. Throws the redirect.
// The last method rides on the same response as the session, so it exists only once
// someone is fully signed in.
export async function finishSignIn(done: Finished): Promise<never> {
  await applyCookies([
    ...done.setCookies,
    ...freshBinding(done.returnTo),
    ...lastMethodCookie(authConfig(), done.session),
  ]);
  const { send, session } = done;
  if (send !== undefined) after(send);
  redirect(
    session === undefined
      ? safeReturnTo(done.returnTo, appOrigin())
      : await arrival(session, done.returnTo),
  );
}

// The form field for this browser. A page cannot set a cookie, so a browser with no pre
// sign in cookie goes through the mint route once and comes back; the fragment survives it.
export async function formBinding(path: string): Promise<string> {
  const config = authConfig();
  const pre = decodeSecret((await cookies()).get(config.cookies.pre)?.value);
  if (pre === null) redirect(preRedirect(path));
  return formBindingField(config, pre);
}

export const hosted = (): boolean => process.env['DREFYN_HOSTED'] === 'true';

export const site = (): Site => ({ hosted: hosted(), docs: docsUrl() });

// Read on the server, so the mark is in the HTML with scripts off and the cookie can stay
// HttpOnly.
export async function lastUsed(): Promise<LastMethod | null> {
  return parseLastMethod((await cookies()).get(authConfig().cookies.lastMethod)?.value);
}
