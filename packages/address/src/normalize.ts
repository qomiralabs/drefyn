declare const brand: unique symbol;

// Only normalizeEmailAddress and the guard produce one, so a value of this type has
// already been through the rule.
export type NormalizedEmailAddress = string & { readonly [brand]: 'NormalizedEmailAddress' };

export interface AddressError {
  readonly code: 'address.invalid';
  readonly reason: 'length' | 'local_part' | 'domain' | 'control' | 'shape';
}

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const MAX_LABEL = 63;
// Long enough for any padded address, short enough that trimming and scanning stay cheap.
const MAX_SCAN = MAX_ADDRESS * 4;

// Dot atom only: no quoted strings, comments, spaces or escapes. Stricter than RFC 5322
// on purpose, because the address parser advisories live in exactly those parts.
const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// The URL host parser drops tabs, decodes percent escapes and stops at / ? # \ and :,
// keeping what came before. Only letters, digits, dots and hyphens may reach it in ASCII;
// anything else ASCII is refused here, and non ASCII is left to IDNA.
const ASCII_OUTSIDE_HOST = /[\0-,/:-@[-`{-\x7f]/;
// IDNA drops these without a trace, so a look alike input would match another address.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
// C0, DEL and C1 controls, plus the two Unicode line breaks some mail clients honour.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const NUMERIC_LAST_LABEL = /\.[0-9]+$/;

const refusal = (reason: AddressError['reason']): AddressError =>
  Object.freeze({ code: 'address.invalid', reason });

// Shared by every caller, so frozen: one caller editing its error cannot change the next.
const refusals: Readonly<Record<AddressError['reason'], AddressError>> = Object.freeze({
  length: refusal('length'),
  local_part: refusal('local_part'),
  domain: refusal('domain'),
  control: refusal('control'),
  shape: refusal('shape'),
});

function refuse(reason: AddressError['reason']): Result<never, AddressError> {
  return { ok: false, error: refusals[reason] };
}

function validLocal(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL) return false;
  return local.split('.').every((atom) => ATOM.test(atom));
}

// The WHATWG host setter is what node:url domainToASCII runs internally, and browsers
// have it too, so this file needs no Node import. Engines still differ in which
// compatibility characters they fold, which the checks before it account for. A failed set leaves the host as
// the placeholder, a single label that the checks below refuse.
function toAscii(domain: string): string {
  const url = new URL('ws://x');
  url.hostname = domain;
  return url.hostname;
}

function asciiDomain(domain: string): string | null {
  if (IGNORABLE.test(domain)) return null;
  // Browsers fold full width and small forms such as U+FF0F and U+FE6B into the ASCII
  // character before splitting the host, and Node does not, so the NFKC form is checked
  // too. The raw form still matters: NFKC turns = plus U+0338 into one non ASCII sign.
  if (ASCII_OUTSIDE_HOST.test(domain) || ASCII_OUTSIDE_HOST.test(domain.normalize('NFKC'))) {
    return null;
  }
  const ascii = toAscii(domain.toLowerCase());
  if (ascii.length > MAX_DOMAIN) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))) return null;
  // A numeric last label means an IP address, which is not a mailbox domain here.
  if (NUMERIC_LAST_LABEL.test(ascii)) return null;
  return ascii;
}

// The form used for lookups, uniqueness and every mail header: trimmed, lower case, ASCII
// domain. No dot or plus folding, since that is the mailbox provider's business.
export function normalizeEmailAddress(input: string): Result<NormalizedEmailAddress, AddressError> {
  if (input.length > MAX_SCAN) return refuse('length');
  // Before trimming, so a trailing newline is refused rather than trimmed away.
  if (input.includes('\r') || input.includes('\n')) return refuse('control');
  const trimmed = input.trim();
  if (CONTROL.test(trimmed)) return refuse('control');
  if (trimmed.length > MAX_ADDRESS) return refuse('length');
  const at = trimmed.indexOf('@');
  if (at < 0 || trimmed.includes('@', at + 1)) return refuse('shape');
  const local = trimmed.slice(0, at);
  if (!validLocal(local)) return refuse('local_part');
  const domain = asciiDomain(trimmed.slice(at + 1));
  if (domain === null) return refuse('domain');
  // IDNA can make the domain longer than the input was.
  const normalized = `${local.toLowerCase()}@${domain}`;
  if (normalized.length > MAX_ADDRESS) return refuse('length');
  return { ok: true, value: normalized as NormalizedEmailAddress };
}

// For values that should already be normalised, such as a stored address or a mail
// recipient. Anything the rule would change or refuse is false.
export function isNormalizedEmailAddress(value: string): value is NormalizedEmailAddress {
  const result = normalizeEmailAddress(value);
  return result.ok && result.value === value;
}
