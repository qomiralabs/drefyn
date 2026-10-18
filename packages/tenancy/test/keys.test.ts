import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  organizationId,
  projectId,
  surrogateKey,
  type CacheScope,
  type OrganizationId,
  type ProjectId,
  type TenantRef,
} from '../src/index.ts';
import { SCOPES, codeOf, expectCode } from './support.ts';

const ORG = '01928c3e-7a9b-7c3d-8e4f-0123456789ab';
const PRJ = '01928c3e-7a9b-7c3d-8e4f-ba9876543210';
// A function so a missing constructor fails each test, not the whole file at load.
function tenant(): TenantRef {
  return { organizationId: organizationId(ORG), projectId: projectId(PRJ) };
}

const CACHE_KEY = /^v1:([0-9a-f-]{36}):([0-9a-f-]{36}):([a-z]+):([A-Za-z0-9_-]{43})$/;

function forged(org: string, prj: string): TenantRef {
  return { organizationId: org as OrganizationId, projectId: prj as ProjectId };
}

describe('cacheKey', () => {
  it.each(SCOPES)('has the v1 shape with organization, project and the %s scope', (scope) => {
    const key = cacheKey(tenant(), scope, 'docs', 'getting-started');
    const match = CACHE_KEY.exec(key);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(ORG);
    expect(match?.[2]).toBe(PRJ);
    expect(match?.[3]).toBe(scope);
  });

  it('builds a key with no parts', () => {
    expect(cacheKey(tenant(), 'nav')).toMatch(CACHE_KEY);
  });

  it('is deterministic and ignores object identity and extra fields', () => {
    const copy = { ...tenant(), label: 'ignored' } as TenantRef;
    expect(cacheKey(copy, 'page', 'a')).toBe(cacheKey(tenant(), 'page', 'a'));
  });

  it('never shows the parts, which may hold paths or queries', () => {
    const key = cacheKey(tenant(), 'search', 'customer secret query');
    expect(key).not.toContain('customer');
    expect(key).not.toContain('secret');
  });

  it('hashes with SHA-256 into 43 base64url characters', () => {
    const hash = cacheKey(tenant(), 'page', 'x').split(':')[4];
    expect(hash).toHaveLength(43);
    expect(Buffer.from(hash ?? '', 'base64url')).toHaveLength(32);
  });

  it('uses the full base64url alphabet, not 43 hex characters that carry 172 bits', () => {
    const symbols = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      for (const c of cacheKey(tenant(), 'page', String(i)).split(':')[4] ?? '') symbols.add(c);
    }
    expect([...symbols].some((c) => !/[0-9a-f]/.test(c))).toBe(true);
    expect(symbols.size).toBeGreaterThan(40);
  });

  // Each pair would collide under a naive join or concatenation of the parts.
  const collisions: readonly [string, readonly string[], readonly string[]][] = [
    ['join on colon', ['a', 'b'], ['a:b']],
    ['concatenation', ['a', 'b'], ['ab']],
    ['empty part', ['a', '', 'b'], ['a', 'b']],
    ['no part and one empty part', [], ['']],
    ['two empty parts', [''], ['', '']],
    ['nul joined', ['a', 'b'], ['a\u0000b']],
    ['newline joined', ['a', 'b'], ['a\nb']],
    ['comma joined', ['a', 'b'], ['a,b']],
    ['json array', ['a', 'b'], ['["a","b"]']],
    ['length prefix lookalike', ['1:a'], ['1', 'a']],
    ['NFC and NFD', ['\u00e9'], ['e\u0301']],
    ['two lone surrogates', ['\ud800'], ['\udbff']],
    ['lone surrogate and replacement character', ['\ud800'], ['\ufffd']],
    ['trailing space', ['a'], ['a ']],
    ['case', ['A'], ['a']],
  ];

  it.each(collisions)('separates parts that collide under %s', (_label, left, right) => {
    expect(cacheKey(tenant(), 'page', ...left)).not.toBe(cacheKey(tenant(), 'page', ...right));
  });

  it('handles a megabyte part', () => {
    expect(cacheKey(tenant(), 'render', 'x'.repeat(1_000_000))).toMatch(CACHE_KEY);
  });

  it('rejects a tenant whose ids were forged past the types', () => {
    expectCode(() => cacheKey(forged('x:y', PRJ), 'page'), 'ID_MALFORMED');
    expectCode(() => cacheKey(forged(ORG, 'y:z'), 'page'), 'ID_MALFORMED');
    expectCode(() => cacheKey(forged(ORG.toUpperCase(), PRJ), 'page'), 'ID_MALFORMED');
    expectCode(() => cacheKey(forged('', ''), 'page'), 'ID_MALFORMED');
  });

  it('cannot be tricked into the same prefix by moving a colon between the ids', () => {
    // v1:x:y:z:... would read the same for org "x:y" with project "z" and org "x" with "y:z".
    expectCode(() => cacheKey(forged('x:y', 'z'), 'page'), 'ID_MALFORMED');
    expectCode(() => cacheKey(forged('x', 'y:z'), 'page'), 'ID_MALFORMED');
  });

  it('rejects an organization ref with no project at run time', () => {
    const orgOnly = { organizationId: organizationId(ORG) } as unknown as TenantRef;
    expectCode(() => cacheKey(orgOnly, 'page'), 'ID_MALFORMED');
  });

  it.each([null, undefined, 'tenant', 42])('rejects a non object tenant %j', (value) => {
    const code = codeOf(() => cacheKey(value as unknown as TenantRef, 'page'));
    expect(code).not.toBe('no error');
  });

  it.each(['', 'Page', 'pages', 'page:evil', 'page ', '__proto__', 'toString'])(
    'rejects unknown scope %j at run time',
    (scope) => {
      expect(codeOf(() => cacheKey(tenant(), scope as CacheScope))).not.toBe('no error');
    },
  );

  const nonStrings: unknown[] = [42, null, undefined, {}, ['a']];
  it.each(nonStrings)('rejects a non string part %j', (part) => {
    expect(codeOf(() => cacheKey(tenant(), 'page', part as string))).not.toBe('no error');
  });
});

describe('surrogateKey', () => {
  const SURROGATE = /^v1:[0-9a-f-]{36}:[0-9a-f-]{36}:[a-z]+(?::[A-Za-z0-9_-]+)?$/;

  it.each(SCOPES)('starts with the same tenant prefix as cacheKey for %s', (scope) => {
    const prefix = `v1:${ORG}:${PRJ}:${scope}`;
    expect(surrogateKey(tenant(), scope)).toMatch(SURROGATE);
    expect(surrogateKey(tenant(), scope).startsWith(prefix)).toBe(true);
    expect(surrogateKey(tenant(), scope, 'node-1').startsWith(`${prefix}:`)).toBe(true);
    expect(cacheKey(tenant(), scope).startsWith(`${prefix}:`)).toBe(true);
  });

  it('is safe in a Surrogate-Key header: visible ASCII, no spaces, at most 1024 bytes', () => {
    for (const id of [undefined, 'a b', 'a\tb\nc', '\u00e9\u{1f600}', 'x'.repeat(10_000), '']) {
      const key =
        id === undefined ? surrogateKey(tenant(), 'page') : surrogateKey(tenant(), 'page', id);
      expect(key).toMatch(/^[\x21-\x7e]+$/);
      expect(Buffer.byteLength(key)).toBeLessThanOrEqual(1024);
    }
  });

  it('is deterministic', () => {
    expect(surrogateKey({ ...tenant() }, 'asset', 'logo')).toBe(
      surrogateKey(tenant(), 'asset', 'logo'),
    );
  });

  it('separates no id, an empty id and ids that differ only in spacing', () => {
    const keys = [
      surrogateKey(tenant(), 'page'),
      surrogateKey(tenant(), 'page', ''),
      surrogateKey(tenant(), 'page', 'a b'),
      surrogateKey(tenant(), 'page', 'a  b'),
      surrogateKey(tenant(), 'page', 'a_b'),
      surrogateKey(tenant(), 'page', 'a:b'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rejects a tenant whose ids were forged past the types', () => {
    expectCode(() => surrogateKey(forged('x:y', 'z'), 'page'), 'ID_MALFORMED');
    expectCode(() => surrogateKey(forged(ORG, `${PRJ} v1:other`), 'page'), 'ID_MALFORMED');
  });

  it.each(['', 'pages', 'page evil', 'page:x'])('rejects unknown scope %j', (scope) => {
    expect(codeOf(() => surrogateKey(tenant(), scope as CacheScope))).not.toBe('no error');
  });
});
