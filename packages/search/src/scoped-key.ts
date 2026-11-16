import { createHmac } from 'node:crypto';

// What a scoped key carries. Typesense ANDs filter_by with any filter in the request and lets
// every other embedded parameter win over the request's own.
export interface ScopedKeyParams {
  readonly filter_by: string;
  readonly expires_at: number;
  // Without these, pinned_hits in the request skips the filter. Measured on 30.2.
  readonly filter_curated_hits: true;
  readonly enable_overrides: false;
  readonly limit_hits?: number;
}

// The documented scheme: base64 of the HMAC-SHA256 digest (itself base64), the first four
// characters of the parent key, then the parameters as JSON. Pure, so a test can check a key
// byte for byte.
export function generateScopedKey(parentKey: string, params: ScopedKeyParams): string {
  if (parentKey.length < 4) throw new RangeError('parent key is too short');
  if (!Number.isSafeInteger(params.expires_at) || params.expires_at <= 0) {
    throw new RangeError('expires_at must be a positive whole number of seconds');
  }
  const json = JSON.stringify(params);
  const digest = createHmac('sha256', parentKey).update(json).digest('base64');
  return Buffer.from(`${digest}${parentKey.slice(0, 4)}${json}`, 'utf8').toString('base64');
}
