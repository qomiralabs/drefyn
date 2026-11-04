import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER, requestPath, requestPathname } from './server/origin.ts';
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

const isTokenInPath = (pathname: string): boolean =>
  pathname.startsWith('/invite/') && pathname !== '/invite/block';

// Headers and the nonce only. Who may see a page is decided by the guard each page awaits.
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const headers = securityHeaders({
    nonce,
    pathname: requestPathname(request),
    https,
    development,
  });
  // Next writes the path into its 404 payload, and a token here must reach neither that page
  // nor a log. Invitation tokens live in the fragment, so this path is only ever a mistake.
  if (isTokenInPath(requestPathname(request))) {
    const refused = new NextResponse('Not found', { status: 404 });
    for (const [name, value] of Object.entries(headers)) refused.headers.set(name, value);
    return refused;
  }
  const forwarded = forwardedRequestHeaders(
    request.headers,
    nonce,
    headers['Content-Security-Policy'],
  );
  // Always overwritten, so what the guard reads is never what the client sent.
  forwarded.set(REQUEST_PATH_HEADER, requestPath(request));
  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

// Hashed build output never changes and holds no account data, so it keeps its long cache.
export const config = {
  matcher: ['/((?!_next/static/|_next/image).*)'],
};
