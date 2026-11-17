import { createHmac } from 'node:crypto';
import { organizationId, projectId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildPublishedQuery,
  MARK_END,
  MARK_START,
  MAX_HITS,
  PUBLIC_COLLECTION_PATTERN,
  publicCollectionFor,
  publishedFilter,
} from '../src/filter.ts';
import { parseSearchPin, type SearchPin } from '../src/pin.ts';
import { parseSearchQuery, type SearchQuery } from '../src/query.ts';
import { generateScopedKey, type ScopedKeyParams } from '../src/scoped-key.ts';
import { decodeScopedKey, TENANT_A } from './support.ts';

const pin = (version: string, locale: string): SearchPin => {
  const parsed = parseSearchPin({ version, locale });
  if (parsed === null) throw new Error('bad pin in test');
  return parsed;
};

const query = (text: string): SearchQuery => {
  const parsed = parseSearchQuery(text);
  if (!parsed.ok) throw new Error('bad query in test');
  return parsed.query;
};

const PARAMS: ScopedKeyParams = {
  filter_by: 'organization_id:=`a`',
  expires_at: 1_900_000_000,
  filter_curated_hits: true,
  enable_overrides: false,
  limit_hits: 20,
};

describe('generateScopedKey', () => {
  it('follows the Typesense scheme: digest, key prefix, then the parameters', () => {
    const parent = 'parentkeyvalue0123456789abcdefgh';
    const key = generateScopedKey(parent, PARAMS);
    const decoded = decodeScopedKey(key);
    const json = JSON.stringify(PARAMS);
    expect(decoded.digest).toBe(createHmac('sha256', parent).update(json).digest('base64'));
    expect(decoded.prefix).toBe('pare');
    expect(decoded.params).toEqual(PARAMS);
  });

  it('is deterministic and changes with any parameter or parent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 64 }),
        fc.string({ maxLength: 200 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        (parent, filter, expires) => {
          const params = { ...PARAMS, filter_by: filter, expires_at: expires };
          const key = generateScopedKey(parent, params);
          expect(generateScopedKey(parent, params)).toBe(key);
          expect(generateScopedKey(parent, { ...params, expires_at: expires + 1 })).not.toBe(key);
          expect(generateScopedKey(`${parent}x`, params)).not.toBe(key);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a short parent and a bad expiry', () => {
    expect(() => generateScopedKey('abc', PARAMS)).toThrow(RangeError);
    expect(() => generateScopedKey('abcd', { ...PARAMS, expires_at: 0 })).toThrow(RangeError);
    expect(() => generateScopedKey('abcd', { ...PARAMS, expires_at: 1.5 })).toThrow(RangeError);
  });
});

describe('publishedFilter', () => {
  it('pins organization, project, version, locale and visibility', () => {
    expect(publishedFilter(TENANT_A, pin('v2', 'de'))).toBe(
      'organization_id:=`0190a3c4-1111-7000-8000-00000000000a` && ' +
        'project_id:=`0190a3c4-2222-7000-8000-00000000000a` && ' +
        'version_key:=`v2` && locale:=`de` && visibility:=public',
    );
  });

  it('names each id exactly once, quoted, for any tenant and pin', () => {
    const uuid = fc.uuid({ version: 7 });
    fc.assert(
      fc.property(
        uuid,
        uuid,
        fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,31}$/),
        (org, prj, version) => {
          const tenant = { organizationId: organizationId(org), projectId: projectId(prj) };
          const filter = publishedFilter(tenant, pin(version, 'en'));
          expect(filter.split('&&')).toHaveLength(5);
          expect(filter).toContain(`organization_id:=\`${org}\``);
          expect(filter).toContain(`project_id:=\`${prj}\``);
          expect(filter).toContain(`version_key:=\`${version}\``);
          expect(filter).not.toMatch(/\|\|/);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a value holding a backtick, should a pin ever skip its parser', () => {
    const forged = { version: 'v1`', locale: 'en' } as unknown as SearchPin;
    expect(() => publishedFilter(TENANT_A, forged)).toThrow(RangeError);
  });
});

describe('publicCollectionFor', () => {
  it('names one public collection per site that the parent key pattern matches', () => {
    const name = publicCollectionFor(TENANT_A);
    expect(name).toBe('docs_pub_0190a3c422227000800000000000000a');
    expect(new RegExp(PUBLIC_COLLECTION_PATTERN).test(name)).toBe(true);
  });

  it('refuses a project id that is not a canonical UUID', () => {
    const forged = { ...TENANT_A, projectId: '../keys' } as unknown as typeof TENANT_A;
    expect(() => publicCollectionFor(forged)).toThrow(RangeError);
  });
});

describe('buildPublishedQuery', () => {
  it('sends the tenant filter again, caps hits and asks for marked body snippets', () => {
    const request = buildPublishedQuery(TENANT_A, pin('latest', 'default'), query('install'));
    expect(request.collection).toBe(publicCollectionFor(TENANT_A));
    expect(request.params).toMatchObject({
      q: 'install',
      filter_by: publishedFilter(TENANT_A, pin('latest', 'default')),
      per_page: String(MAX_HITS),
      highlight_start_tag: MARK_START,
      highlight_end_tag: MARK_END,
    });
    expect(Object.keys(request.params)).not.toContain('pinned_hits');
  });
});
