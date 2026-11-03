import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { formatApiKey } from '../src/index.ts';
import { runs, secretBytes } from './support.ts';

const config = readFileSync(new URL('../../../.gitleaks.toml', import.meta.url), 'utf8');

// The rule's pattern as gitleaks reads it. It uses no syntax where RE2 and JavaScript differ.
function rulePattern(): RegExp {
  const block = config.split('[[rules]]').find((b) => b.includes('id = "drefyn-api-key"'));
  const raw = block?.match(/regex = '''(.+)'''/)?.[1];
  if (raw === undefined) throw new Error('no drefyn-api-key rule');
  return new RegExp(raw);
}

const key = fc
  .tuple(fc.uuid({ version: 7 }), fc.uuid({ version: 7 }), secretBytes)
  .map(([org, id, secret]) =>
    formatApiKey({ organizationId: idOf('org', org), keyId: idOf('key', id), secret }),
  );

describe('the gitleaks rule for drf_ak_', () => {
  it('keeps the default rules and adds ours', () => {
    expect(config).toMatch(/\[extend\]\s+useDefault = true/);
    expect(config).toContain('keywords = ["drf_ak_"]');
  });

  it('matches every generated key, whole', () => {
    const pattern = rulePattern();
    fc.assert(
      fc.property(key, (k) => {
        expect(k.match(pattern)?.[0]).toBe(k);
      }),
      runs,
    );
  });

  it('matches a key inside other text', () => {
    fc.assert(
      fc.property(key, (k) => {
        expect(rulePattern().test(`export DREFYN_API_KEY="${k}" # ci`)).toBe(true);
      }),
      runs,
    );
  });

  it('does not match the format written out, or a key cut short', () => {
    const pattern = rulePattern();
    expect(pattern.test('drf_ak_<organization>_<key>_<secret>')).toBe(false);
    fc.assert(
      fc.property(key, (k) => {
        expect(pattern.test(k.slice(0, -1))).toBe(false);
      }),
      runs,
    );
  });
});
