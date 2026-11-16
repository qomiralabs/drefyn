declare const queryBrand: unique symbol;

// Search text after the checks below. Only parseSearchQuery makes one.
export type SearchQuery = string & { readonly [queryBrand]: true };

export const MAX_QUERY_BYTES = 256;

const encoder = new TextEncoder();
// Control and format characters carry no meaning in a search box and can hide text from a
// reader of the request.
const INVISIBLE = /[\p{Cc}\p{Cf}]+/gu;

export type QueryRefusal = 'empty' | 'too_long' | 'not_text';

export type ParsedQuery =
  | { readonly ok: true; readonly query: SearchQuery }
  | { readonly ok: false; readonly reason: QueryRefusal };

// The byte cap applies to what the reader sent, before any cleanup, so a long run of stripped
// characters cannot slip past it.
export function parseSearchQuery(raw: unknown): ParsedQuery {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_text' };
  if (!raw.isWellFormed()) return { ok: false, reason: 'not_text' };
  if (encoder.encode(raw).byteLength > MAX_QUERY_BYTES) return { ok: false, reason: 'too_long' };
  const text = raw.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/gu, ' ').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  return { ok: true, query: text as SearchQuery };
}
