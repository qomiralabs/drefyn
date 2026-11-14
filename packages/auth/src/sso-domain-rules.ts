import { domainToASCII } from 'node:url';
import { normalizeEmailAddress } from '@drefyn/address';
import { AuthError } from './errors.ts';

// The label a verification record lives under. The leading underscore keeps it out of the
// host name space, so it can never collide with a real host.
export const SSO_TXT_LABEL = '_drefyn-sso';
const MAX_NAME = 253;
const MAX_DOMAIN = MAX_NAME - SSO_TXT_LABEL.length - 1;
// Far past any real domain, so trimming and scanning a hostile value stays cheap.
const MAX_INPUT = 1024;

export const ssoTxtName = (domain: string): string => `${SSO_TXT_LABEL}.${domain}`;

// The domain the way @drefyn/address keeps the domain of an address, so a claim and the
// addresses it covers can never disagree on spelling: lower case, IDN in punycode. One
// trailing dot is the DNS root and is dropped. null for anything that is not a domain, or
// whose TXT name would be too long to look up.
export function normalizeSsoDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return null;
  // Before trimming, so a pasted line break is refused rather than trimmed away.
  if (value.includes('\r') || value.includes('\n')) return null;
  let domain = value.trim();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  // The address rule reads everything after the first @, so one here would be a second.
  if (domain === '' || domain.includes('@')) return null;
  const result = normalizeEmailAddress(`a@${domain}`);
  if (!result.ok) return null;
  const ascii = result.value.slice(2);
  return ascii.length <= MAX_DOMAIN ? ascii : null;
}

export interface PublicSuffixList {
  // For a normalized domain: true when it is itself a public suffix, so nobody can own it.
  isPublicSuffix(domain: string): boolean;
  readonly size: number;
}

const RULE_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function asciiRule(rule: string): string {
  const ascii = domainToASCII(rule);
  if (ascii === '' || !ascii.split('.').every((label) => RULE_LABEL.test(label))) {
    throw new AuthError('AUTH_CONFIG_INVALID', { reason: 'public suffix rule is not readable' });
  }
  return ascii;
}

// The list's own format: one rule a line, the rule ending at the first space, // comments,
// *. for a wildcard over one label and ! for an exception to one. A rule it cannot read is
// an error, never skipped, since a skipped rule is a suffix someone could claim.
export function parsePublicSuffixList(text: string): PublicSuffixList {
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const line of text.split('\n')) {
    const rule = line.trim().split(/\s/)[0] ?? '';
    if (rule === '' || rule.startsWith('//')) continue;
    if (rule.startsWith('!')) exception.add(asciiRule(rule.slice(1)));
    else if (rule.startsWith('*.')) wildcard.add(asciiRule(rule.slice(2)));
    else exact.add(asciiRule(rule));
  }
  const size = exact.size + wildcard.size + exception.size;
  if (size === 0) {
    throw new AuthError('AUTH_CONFIG_INVALID', { reason: 'public suffix list is empty' });
  }
  return Object.freeze({
    size,
    isPublicSuffix(domain: string) {
      if (exception.has(domain)) return false;
      if (exact.has(domain)) return true;
      const dot = domain.indexOf('.');
      return dot > 0 && wildcard.has(domain.slice(dot + 1));
    },
  });
}

// Mailbox providers anyone can sign up to. Proving one would hand an IdP every address
// in it. Our own list of the large consumer providers; an operator adds more in a file.
export const FREE_MAIL_DOMAINS: readonly string[] = Object.freeze([
  '126.com',
  '163.com',
  'aim.com',
  'aol.com',
  'bk.ru',
  'daum.net',
  'fastmail.com',
  'free.fr',
  'gmail.com',
  'gmx.at',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'hanmail.net',
  'hey.com',
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.de',
  'hotmail.fr',
  'icloud.com',
  'inbox.ru',
  'laposte.net',
  'libero.it',
  'list.ru',
  'live.com',
  'mac.com',
  'mail.com',
  'mail.ru',
  'me.com',
  'msn.com',
  'naver.com',
  'orange.fr',
  'outlook.com',
  'outlook.de',
  'outlook.fr',
  'pm.me',
  'proton.me',
  'protonmail.ch',
  'protonmail.com',
  'qq.com',
  'rambler.ru',
  'rediffmail.com',
  'sina.com',
  't-online.de',
  'tuta.io',
  'tutanota.com',
  'web.de',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.de',
  'yahoo.fr',
  'yandex.com',
  'yandex.ru',
  'ymail.com',
  'zoho.com',
  'zohomail.com',
]);

export type SsoDomainRefusal = 'public_suffix' | 'free_mail';

export interface SsoDomainPolicy {
  // For a normalized domain: why it can never be claimed, or null.
  refusal(domain: string): SsoDomainRefusal | null;
}

export interface SsoDomainPolicyInput {
  readonly publicSuffixes: PublicSuffixList;
  readonly extraFreeMail: readonly string[];
}

export function createSsoDomainPolicy(input: SsoDomainPolicyInput): SsoDomainPolicy {
  const freeMail = new Set<string>(FREE_MAIL_DOMAINS);
  for (const entry of input.extraFreeMail) {
    const domain = normalizeSsoDomain(entry);
    if (domain === null) {
      throw new AuthError('AUTH_CONFIG_INVALID', {
        key: 'DREFYN_AUTH_SSO_FREE_MAIL_DOMAINS_FILE',
        reason: 'holds a line that is not a domain',
      });
    }
    freeMail.add(domain);
  }
  const { publicSuffixes } = input;
  return Object.freeze({
    refusal(domain: string): SsoDomainRefusal | null {
      if (publicSuffixes.isPublicSuffix(domain)) return 'public_suffix';
      // A subdomain of a provider is the provider's too: eu.mail.yahoo.com is Yahoo's.
      for (let at = domain; at !== '';) {
        if (freeMail.has(at)) return 'free_mail';
        const dot = at.indexOf('.');
        at = dot < 0 ? '' : at.slice(dot + 1);
      }
      return null;
    },
  });
}
