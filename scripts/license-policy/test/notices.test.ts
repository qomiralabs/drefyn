import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkNotices, parsePolicy, type Policy } from '../src/policy.ts';

const root = new URL('../../../', import.meta.url);
const real: Policy = parsePolicy(
  JSON.parse(readFileSync(new URL('scripts/license-policy/policy.json', root), 'utf8')),
);
const NOTICES = new URL('THIRD_PARTY_NOTICES.md', root);

const pkg = (name: string, license: string) => ({ name, versions: ['1.0.0'], license });
const entry = (name: string, license: string) =>
  `## ${name}\n\nLicence: ${license}\n\nCopyright the ${name} authors.\n`;

describe('checkNotices', () => {
  it('needs nothing for packages under an allowed licence', () => {
    expect(checkNotices({ MIT: [pkg('left-pad', 'MIT')] }, real, '')).toEqual([]);
  });

  it('names a production package under a non permissive licence with no entry', () => {
    const report = { 'CC-BY-4.0': [pkg('caniuse-lite', 'CC-BY-4.0')] };
    expect(checkNotices(report, real, '# Third party notices\n')).toEqual(['caniuse-lite']);
  });

  it('accepts an entry that names the package and its licence', () => {
    const report = { 'CC-BY-4.0': [pkg('caniuse-lite', 'CC-BY-4.0')] };
    expect(checkNotices(report, real, entry('caniuse-lite', 'CC-BY-4.0'))).toEqual([]);
  });

  it('refuses an entry under the wrong licence or a mention that is not a heading', () => {
    const report = { 'CC-BY-4.0': [pkg('caniuse-lite', 'CC-BY-4.0')] };
    expect(checkNotices(report, real, entry('caniuse-lite', 'MIT'))).toEqual(['caniuse-lite']);
    expect(checkNotices(report, real, 'We use caniuse-lite under CC-BY-4.0.\n')).toEqual([
      'caniuse-lite',
    ]);
    expect(checkNotices(report, real, entry('caniuse-lite-fork', 'CC-BY-4.0'))).toEqual([
      'caniuse-lite',
    ]);
  });

  it('reads the licence from the group when a package has none of its own', () => {
    const report = { 'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.0'] }] };
    expect(checkNotices(report, real, '')).toEqual(['caniuse-lite']);
  });
});

describe('THIRD_PARTY_NOTICES.md', () => {
  it('exists at the repository root', () => {
    expect(existsSync(NOTICES)).toBe(true);
  });

  it('covers every exception allowed in production', () => {
    const text = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '';
    const shipped = real.exceptions.filter((e) => e.devOnly !== true && e.name !== undefined);
    // lightningcss is excepted for the build tool chain only and never ships.
    const report = Object.fromEntries(
      shipped
        .filter((e) => !(e.name ?? '').startsWith('lightningcss'))
        .map((e) => [e.license, [pkg(e.name ?? '', e.license)]]),
    );
    expect(Object.keys(report)).toContain('CC-BY-4.0');
    expect(checkNotices(report, real, text)).toEqual([]);
  });

  it('gives caniuse-lite its CC BY 4.0 attribution', () => {
    const text = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '';
    const section = /^## caniuse-lite\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? '';
    expect(section).toMatch(/Licence: CC-BY-4\.0/);
    expect(section).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(section).toContain('https://caniuse.com');
  });
});
