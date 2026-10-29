import { normalizeEmailAddress, type NormalizedEmailAddress } from '@drefyn/address';

// Auth reads addresses from forms and provider profiles, where anything can arrive, so
// this takes unknown. The rule itself lives in @drefyn/address so email applies the same one.
export function normalizeAddress(value: unknown): NormalizedEmailAddress | null {
  if (typeof value !== 'string') return null;
  const result = normalizeEmailAddress(value);
  return result.ok ? result.value : null;
}
