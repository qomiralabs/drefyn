const FALLBACK = '/';
const MAX_LENGTH = 2048;

// Browsers strip tabs and newlines from URLs and treat \ as /, so any of them can turn a
// path into another host; they are refused rather than cleaned.
const UNSAFE = /[\\\p{Cc}\u2028\u2029]/u;

// Where to send someone after sign in. Anything but a same origin path becomes /.
export function safeReturnTo(value: unknown, appOrigin: string): string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return FALLBACK;
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE.test(value)) return FALLBACK;
  const url = URL.parse(value, appOrigin);
  if (url?.origin !== appOrigin) return FALLBACK;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can collapse to //host after parsing, which a browser reads as another
  // origin, so the result is checked again in the form it leaves in.
  if (path.startsWith('//') || UNSAFE.test(path) || path.length > MAX_LENGTH) return FALLBACK;
  return path;
}
