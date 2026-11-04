import { safeReturnTo } from '@drefyn/auth';
import { z } from 'zod';

// The only file that reads request URLs. Next builds request.url from its own idea of the
// host, so nothing absolute may ever start from one.

export const REQUEST_PATH_HEADER = 'x-drefyn-request-path';

const AppOrigin = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = URL.parse(value);
  return url !== null && url.origin === value;
});

// Throws on a bad value, naming the key and never the value, so every caller fails closed.
export function appOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const parsed = AppOrigin.safeParse(env['DREFYN_APP_ORIGIN']);
  if (!parsed.success) throw new Error('DREFYN_APP_ORIGIN is not a bare http or https origin');
  return parsed.data;
}

// safeReturnTo answers with / for anything it refuses, so only a path that really is the
// root may come back as the root.
export function appUrl(path: string): URL {
  const origin = appOrigin();
  const safe = safeReturnTo(path, origin);
  if (safe === '/' && path !== '/') throw new RangeError('path leaves the configured origin');
  return new URL(safe, origin);
}

interface PathRequest {
  readonly nextUrl: { readonly pathname: string; readonly search: string };
}

export function requestPathname(request: PathRequest): string {
  return request.nextUrl.pathname;
}

export function requestQuery(request: PathRequest): URLSearchParams {
  return new URLSearchParams(request.nextUrl.search);
}

export function requestPath(request: PathRequest): string {
  const { pathname, search } = request.nextUrl;
  return `${pathname}${search}`;
}

// Browsers send Origin on every POST, and non browser clients use the API with keys, so a
// missing one is refused. An empty or odd Sec-Fetch-Site is refused like a cross site one.
export function originAllowed(headers: Pick<Headers, 'get'>, origin: string): boolean {
  if (headers.get('origin') !== origin) return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}
