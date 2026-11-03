import fc from 'fast-check';
import { randomBytes } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AuthError,
  createCliLinks,
  encodeSecret,
  formatCliLinkToken,
  parseAuthConfig,
  parseCliLinkToken,
  slugFromOrganizationName,
  type RateBucket,
} from '../src/index.ts';
import { mutationsOf, runs, secretBytes, validEnv } from './support.ts';

const config = parseAuthConfig(validEnv());

describe('CLI link tokens', () => {
  it('are drf_cl_ and the 52 character secret, and parse back to the same bytes', () => {
    fc.assert(
      fc.property(secretBytes, (bytes) => {
        const token = formatCliLinkToken(bytes);
        expect(token).toBe(`drf_cl_${encodeSecret(bytes)}`);
        expect(token).toMatch(/^drf_cl_[0-9a-hjkmnp-tv-z]{52}$/);
        expect(parseCliLinkToken(token)?.equals(Buffer.from(bytes))).toBe(true);
      }),
      runs,
    );
  });

  it('refuse every single character edit of a valid token', () => {
    const token = formatCliLinkToken(randomBytes(32));
    fc.assert(
      fc.property(mutationsOf(token), (m) => {
        const parsed = parseCliLinkToken(m.value);
        if (parsed !== null) expect(formatCliLinkToken(parsed)).toBe(m.value);
      }),
      runs,
    );
  });

  it.each([
    [undefined],
    [42],
    [''],
    ['drf_cl_'],
    ['drf_ses_' + 'a'.repeat(52)],
    ['DRF_CL_' + 'a'.repeat(52)],
    ['drf_cl_' + 'A'.repeat(52)],
    ['drf_cl_' + 'a'.repeat(51)],
    ['drf_cl_' + 'a'.repeat(53)],
    ['#drf_cl_' + 'a'.repeat(52)],
    [' drf_cl_' + 'a'.repeat(52)],
    // The first symbol carries four spare bits that must be zero.
    ['drf_cl_z' + 'a'.repeat(51)],
  ])('refuse %j', (value) => {
    expect(parseCliLinkToken(value)).toBeNull();
  });
});

describe('organization slugs from a name', () => {
  it.each([
    ['Acme', 'acme'],
    ['Acme Docs Team', 'acme-docs-team'],
    ['  Acme   Docs  ', 'acme-docs'],
    ['Zürich Ops', 'zurich-ops'],
    ['R&D / Platform', 'r-d-platform'],
    ['a'.repeat(60), 'a'.repeat(40)],
    [`${'a'.repeat(39)} b`, 'a'.repeat(39)],
  ])('turns %j into %j', (name, slug) => {
    expect(slugFromOrganizationName(name)).toBe(slug);
  });

  it.each([['   '], ['!!!'], ['日本']])(
    'gives null for %j, which has no usable characters',
    (name) => {
      expect(slugFromOrganizationName(name)).toBeNull();
    },
  );

  it('always gives a slug the slug rule accepts, or null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (name) => {
        const slug = slugFromOrganizationName(name);
        if (slug !== null) expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
      }),
      runs,
    );
  });
});

describe('CLI link redemption order', () => {
  const browser = { ip: '203.0.113.7', userAgent: 'Test/1.0', cookies: new Map<string, string>() };

  function setup(reserve: (bucket: RateBucket) => Promise<void> = () => Promise.resolve()) {
    const reserved: RateBucket[] = [];
    const auth = vi.fn(() => Promise.reject(new Error('the database was reached')));
    const links = createCliLinks(config, {
      db: {} as never,
      authDb: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() },
      initialTier: 'self_hosted',
      limiter: {
        async reserve(bucket) {
          reserved.push(bucket);
          await reserve(bucket);
        },
      },
      store: { auth },
    });
    return { links, reserved, auth };
  }

  it('counts the cli_link_verify bucket first, then refuses a malformed token with no query', async () => {
    const { links, reserved, auth } = setup();
    const result = await links.redeem(browser, 'drf_cl_not-a-secret');
    expect(result).toEqual({ ok: false, error: expect.any(AuthError) });
    expect(!result.ok && result.error.code).toBe('AUTH_CLI_LINK_INVALID');
    expect(reserved).toEqual(['cli_link_verify']);
    expect(auth).not.toHaveBeenCalled();
  });

  it('answers AUTH_RATE_LIMITED when the bucket is full, before parsing anything', async () => {
    const { links, auth } = setup(() => Promise.reject(new AuthError('AUTH_RATE_LIMITED')));
    const result = await links.redeem(browser, formatCliLinkToken(randomBytes(32)));
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
    expect(auth).not.toHaveBeenCalled();
  });

  it('defaults the cli_link_verify bucket to 20 in 15 minutes', () => {
    expect(config.rateLimits.cli_link_verify).toEqual([{ count: 20, windowSeconds: 900 }]);
  });

  it('takes no mailer, so it can never send one', () => {
    expectTypeOf<Parameters<typeof createCliLinks>[1]>().not.toHaveProperty('mailer');
  });
});
