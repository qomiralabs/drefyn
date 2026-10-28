import { domainToASCII } from 'node:url';

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_LABEL = 63;

// Dot atom only: no quoted strings, comments, spaces or escapes. Stricter than RFC 5322
// on purpose, because the address parser advisories live in exactly those parts.
const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validLocal(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL) return false;
  return local.split('.').every((atom) => ATOM.test(atom));
}

function asciiDomain(domain: string): string | null {
  // domainToASCII lets empty labels and IP addresses through, so labels are checked here.
  const ascii = domainToASCII(domain.toLowerCase());
  if (ascii === '' || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))) return null;
  // A numeric last label means an IP address, which is not a mailbox domain here.
  if (/^[0-9]+$/.test(labels.at(-1) ?? '')) return null;
  return ascii;
}

// The form used for lookups and uniqueness: trimmed, lower case, ASCII domain. No dot or
// plus folding, since that is the provider's business. Null when refused.
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS * 4) return null;
  // Before trimming, so a trailing newline is refused rather than trimmed away.
  if (value.includes('\r') || value.includes('\n')) return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_ADDRESS) return null;
  const at = trimmed.indexOf('@');
  if (at < 0 || trimmed.includes('@', at + 1)) return null;
  const local = trimmed.slice(0, at);
  if (!validLocal(local)) return null;
  const domain = asciiDomain(trimmed.slice(at + 1));
  if (domain === null) return null;
  const normalized = `${local.toLowerCase()}@${domain}`;
  return normalized.length > MAX_ADDRESS ? null : normalized;
}
