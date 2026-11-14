import { readFileSync } from 'node:fs';
import { domainToASCII } from 'node:url';
import { normalizeEmailAddress } from '@drefyn/address';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FREE_MAIL_DOMAINS,
  bundledPublicSuffixListPath,
  createSsoDomainPolicy,
  normalizeSsoDomain,
  parsePublicSuffixList,
} from '../src/index.ts';
import { ADMIN, CONNECTION_A, ORG_A, accessFor, domainWorld } from './sso-domain-fakes.ts';
import { runs } from './support.ts';

// The domain part @drefyn/address keeps for an address at this domain, or null if refused.
function addressDomain(domain: string): string | null {
  const result = normalizeEmailAddress(`a@${domain}`);
  return result.ok ? result.value.slice(result.value.indexOf('@') + 1) : null;
}

const letter = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
const unicodeLetter = fc.constantFrom(...'äöüßéñçøåıİΣσςж中文日本한국');
const label = fc
  .array(fc.oneof({ weight: 8, arbitrary: letter }, { weight: 1, arbitrary: fc.constant('-') }), {
    minLength: 1,
    maxLength: 20,
  })
  .map((chars) => chars.join(''));
const idnLabel = fc
  .array(fc.oneof(letter, unicodeLetter), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(''));
const domainish = fc
  .array(fc.oneof({ weight: 4, arbitrary: label }, { weight: 1, arbitrary: idnLabel }), {
    minLength: 1,
    maxLength: 5,
  })
  .map((labels) => labels.join('.'));
// Anything at all, for the refusal side.
const noise = fc.string({ maxLength: 80, unit: 'binary' });

const TXT_PREFIX_LENGTH = '_drefyn-sso.'.length;

describe('normalizeSsoDomain', () => {
  it('keeps the domain exactly as @drefyn/address keeps it, or refuses it', () => {
    fc.assert(
      fc.property(fc.oneof(domainish, noise), (input) => {
        const ours = normalizeSsoDomain(input);
        const theirs = addressDomain(input);
        if (ours === null) {
          // Refused here but kept there only when the TXT name would run past 253.
          if (theirs !== null) expect(theirs.length + TXT_PREFIX_LENGTH).toBeGreaterThan(253);
          return;
        }
        expect(ours).toBe(theirs);
      }),
      runs,
    );
  });

  it('reads one trailing dot as the root, and spaces around as nothing', () => {
    fc.assert(
      fc.property(domainish, (input) => {
        const plain = normalizeSsoDomain(input);
        expect(normalizeSsoDomain(`${input}.`)).toBe(plain);
        expect(normalizeSsoDomain(`  ${input}. `)).toBe(plain);
        expect(normalizeSsoDomain(`${input}..`)).toBeNull();
      }),
      runs,
    );
  });

  it('is case blind and idempotent, and gives lower case ASCII', () => {
    fc.assert(
      fc.property(domainish, (input) => {
        const once = normalizeSsoDomain(input);
        expect(normalizeSsoDomain(input.toUpperCase())).toBe(
          // Upper casing can change a Unicode letter (ß to SS), which IDNA then reads apart.
          normalizeSsoDomain(input.toUpperCase().toLowerCase()),
        );
        if (once === null) return;
        expect(normalizeSsoDomain(once)).toBe(once);
        expect(once).toMatch(/^[a-z0-9.-]+$/);
      }),
      runs,
    );
  });

  it('turns an IDN into its punycode form', () => {
    fc.assert(
      fc.property(fc.tuple(idnLabel, label), ([left, right]) => {
        const input = `${left}.${right}`;
        const ours = normalizeSsoDomain(input);
        if (ours === null) return;
        expect(ours).toBe(domainToASCII(input.toLowerCase()));
      }),
      runs,
    );
  });

  it('refuses whatever is not a string', () => {
    for (const value of [undefined, null, 1, {}, ['acme.test'], Symbol('x')]) {
      expect(normalizeSsoDomain(value)).toBeNull();
    }
  });
});

describe('subdomains', () => {
  it('make their own claims, apart from the parent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { minLength: 1, maxLength: 4 }),
        async (subs) => {
          const w = domainWorld();
          const ids = new Set<string>();
          for (const name of ['acme.test', ...subs.map((s) => `${s}.acme.test`)]) {
            const claim = await w.domains.claimDomain(accessFor(ORG_A, ADMIN), CONNECTION_A, name);
            if (!claim.ok) throw claim.error;
            ids.add(claim.value.domainId);
          }
          expect(ids.size).toBe(subs.length + 1);
        },
      ),
      { ...runs, numRuns: 50 },
    );
  });
});

describe('the public suffix check over the bundled list', () => {
  const text = readFileSync(bundledPublicSuffixListPath(), 'utf8');
  const suffixes = parsePublicSuffixList(text);
  const rules = text
    .split('\n')
    .map((line) => line.trim().split(/\s/)[0] ?? '')
    .filter((line) => line !== '' && !line.startsWith('//'));
  const exact = rules
    .filter((r) => !r.startsWith('*.') && !r.startsWith('!'))
    .map((r) => domainToASCII(r));
  const wildcards = rules.filter((r) => r.startsWith('*.')).map((r) => domainToASCII(r.slice(2)));
  const exceptions = new Set(
    rules.filter((r) => r.startsWith('!')).map((r) => domainToASCII(r.slice(1))),
  );
  const ruleSet = new Set(exact);
  const registrable = fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/).map((s) => `zz${s}`);

  it('names every listed rule a public suffix', () => {
    fc.assert(
      fc.property(fc.constantFrom(...exact), (rule) => {
        expect(suffixes.isPublicSuffix(rule)).toBe(true);
      }),
      runs,
    );
  });

  it('names one label under a wildcard a suffix, unless it is an exception', () => {
    fc.assert(
      fc.property(fc.constantFrom(...wildcards), registrable, (parent, name) => {
        const domain = `${name}.${parent}`;
        expect(suffixes.isPublicSuffix(domain)).toBe(!exceptions.has(domain));
      }),
      runs,
    );
    for (const exception of exceptions) expect(suffixes.isPublicSuffix(exception)).toBe(false);
  });

  it('never names a fresh label under a plain rule a suffix', () => {
    fc.assert(
      fc.property(fc.constantFrom(...exact), registrable, (rule, name) => {
        const domain = `${name}.${rule}`;
        fc.pre(!ruleSet.has(domain) && !wildcards.includes(rule));
        expect(suffixes.isPublicSuffix(domain)).toBe(false);
      }),
      runs,
    );
  });

  it('refuses every suffix and allows a registrable name under it in the policy', () => {
    const policy = createSsoDomainPolicy({ publicSuffixes: suffixes, extraFreeMail: [] });
    const free = new Set(FREE_MAIL_DOMAINS);
    fc.assert(
      fc.property(fc.constantFrom(...exact), registrable, (rule, name) => {
        fc.pre(rule.split('.').length >= 1);
        expect(policy.refusal(rule)).not.toBeNull();
        const domain = `${name}.${rule}`;
        fc.pre(!ruleSet.has(domain) && !wildcards.includes(rule) && !free.has(rule));
        expect(policy.refusal(domain)).toBeNull();
      }),
      runs,
    );
  });
});
