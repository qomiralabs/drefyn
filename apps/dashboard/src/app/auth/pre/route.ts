import { randomBytes } from 'node:crypto';
import { encodeSecret, PRE_MAX_AGE_SECONDS, serializeCookie } from '@drefyn/auth';
import type { NextRequest } from 'next/server';
import { preTarget } from '../../../auth/pre-target.ts';
import { authConfig } from '../../../server/auth.ts';
import { guardPublic } from '../../../server/guard.ts';
import { appUrl, requestQuery } from '../../../server/origin.ts';

const SECRET_BYTES = 32;

// Pages cannot set cookies, and a cookie on a 404 would announce a dashboard the flag says
// is not there, so this route mints the pre sign in cookie after the flag has answered.
export async function GET(request: NextRequest): Promise<Response> {
  await guardPublic();
  const config = authConfig();
  const cookie = serializeCookie(config, {
    name: config.cookies.pre,
    value: encodeSecret(randomBytes(SECRET_BYTES)),
    maxAgeSeconds: PRE_MAX_AGE_SECONDS,
  });
  const target = appUrl(preTarget(requestQuery(request).get('to')));
  return new Response(null, {
    status: 303,
    headers: { location: target.href, 'set-cookie': cookie },
  });
}
