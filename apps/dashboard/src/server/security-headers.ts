import { z } from 'zod';

// The proxy hands the layout its nonce in this request header, always overwriting what the
// client sent.
export const NONCE_HEADER = 'x-drefyn-nonce';

// Base64 only, so a nonce can never close the quote or start a new directive.
const NONCE_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

// No 'unsafe-inline' anywhere. React Aria's one injected style takes the nonce from the
// csp-nonce meta tag in the root layout. next dev needs eval to rebuild server error stacks
// in the browser; a production build never does.
export function contentSecurityPolicy(nonce: string, development = false): string {
  if (!NONCE_SHAPE.test(nonce)) throw new Error('CSP nonce must be base64');
  const allowEval = development ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${allowEval}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

// These pages are opened from links that carry a secret. The secret sits in the fragment,
// which browsers never send, and sending no referrer off the site is the second lock. Not
// no-referrer: under it a browser posts a plain form with Origin: null, which every Origin
// check refuses, so these pages could not work with scripts off.
const NO_REFERRER = ['/sign-in/verify', '/sign-in/cli', '/invite'] as const;

function referrerPolicy(pathname: string): string {
  const quiet = NO_REFERRER.some((base) => pathname === base || pathname.startsWith(`${base}/`));
  return quiet ? 'same-origin' : 'strict-origin-when-cross-origin';
}

export interface HeaderOptions {
  readonly nonce: string;
  readonly pathname: string;
  // True only when the configured app origin is https.
  readonly https: boolean;
  readonly development: boolean;
}

export type SecurityHeaders = Readonly<{
  'Content-Security-Policy': string;
  [name: string]: string;
}>;

// Every dashboard response shows account data or is an auth step, so nothing is cached.
// HSTS on an http origin would pin a loopback dev host to https; preload is a domain wide
// choice left to whoever runs the domain.
export function securityHeaders(options: HeaderOptions): SecurityHeaders {
  return {
    'Content-Security-Policy': contentSecurityPolicy(options.nonce, options.development),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': referrerPolicy(options.pathname),
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(options.https
      ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' }
      : {}),
  };
}

// Next reads the nonce for its own scripts from the request's CSP header, and the layout
// reads ours, so both are set here whatever the client sent.
export function forwardedRequestHeaders(incoming: Headers, nonce: string, policy: string): Headers {
  const headers = new Headers(incoming);
  headers.set(NONCE_HEADER, nonce);
  headers.set('content-security-policy', policy);
  return headers;
}

const AppOrigin = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value))
  .pipe(z.url({ protocol: /^https?$/ }).optional());

// The scheme comes from configuration, never from X-Forwarded-Proto, which a client can set.
// No origin, as on a loopback dev or test server, means no HSTS.
export function servedOverHttps(env: Readonly<Record<string, string | undefined>>): boolean {
  const parsed = AppOrigin.safeParse(env['DREFYN_APP_ORIGIN']);
  if (!parsed.success) throw new Error('DREFYN_APP_ORIGIN must be an http or https URL');
  return parsed.data?.startsWith('https:') ?? false;
}
