import { rateKeyForIp } from '@drefyn/auth';

export type ClientAddressProblem = 'no_wrapper' | 'missing' | 'list' | 'unparsable';

export type ClientAddress =
  | { readonly ok: true; readonly ip: string }
  | { readonly ok: false; readonly reason: ClientAddressProblem };

// A value the rate limiter could not key would fail later, so it fails here.
function keyable(value: string): boolean {
  try {
    rateKeyForIp(value);
    return true;
  } catch {
    return false;
  }
}

// The wrapper writes exactly one literal. Anything else means it is not in front of Next,
// so the caller refuses: a fallback here would be a key the client chose, or one key shared
// by everyone. No other client address header is ever read.
export function readClientAddress(
  headers: Pick<Headers, 'get'>,
  wrapperRunning: boolean,
): ClientAddress {
  if (!wrapperRunning) return { ok: false, reason: 'no_wrapper' };
  const value = headers.get('x-forwarded-for');
  if (value === null) return { ok: false, reason: 'missing' };
  if (value.includes(',')) return { ok: false, reason: 'list' };
  return keyable(value) ? { ok: true, ip: value } : { ok: false, reason: 'unparsable' };
}
