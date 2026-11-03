import { NextResponse, type NextRequest } from 'next/server';
import {
  forwardedRequestHeaders,
  newNonce,
  securityHeaders,
  servedOverHttps,
} from './server/security-headers.ts';

// Read once at startup; a malformed origin fails every request rather than serving without
// the headers.
const https = servedOverHttps(process.env);
const development = process.env.NODE_ENV === 'development';

// Headers and the nonce only. Who may see a page is decided by the guard each page awaits.
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const headers = securityHeaders({
    nonce,
    pathname: request.nextUrl.pathname,
    https,
    development,
  });
  const response = NextResponse.next({
    request: {
      headers: forwardedRequestHeaders(request.headers, nonce, headers['Content-Security-Policy']),
    },
  });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

// Hashed build output never changes and holds no account data, so it keeps its long cache.
export const config = {
  matcher: ['/((?!_next/static/|_next/image).*)'],
};
