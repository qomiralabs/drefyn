import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { idOf, organizationId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { parseAuthConfig, type RateLimiter, type StartSessionInput } from '../src/index.ts';
import { createSsoSignIn } from '../src/sso-sign-in.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import {
  DISPLAY_NAME_MAX,
  SUBJECT_MAX,
  cleanDisplayName,
  isVerifiedIdentity,
  mintVerifiedIdentity,
} from '../src/verified-identity.ts';
import { Jar, logRecorder } from './oauth-fixtures.ts';
import { ssoStore } from './sso-store.ts';
import { runs, validEnv } from './support.ts';

const ORG = '01a14984-4476-77ce-9335-12800000b001';
const CONN = '01a14984-4476-77ce-9335-12800000b002';
const NOW = new Date('2026-11-14T12:00:00Z');
const DAY_MS = 86_400_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const points = (s: string) => Array.from(s).length;

const claims = (over: Record<string, unknown> = {}) => ({
  protocol: 'oidc' as const,
  organizationId: ORG,
  connectionId: CONN,
  subject: 'sub',
  email: 'ada@example.com',
  displayName: null,
  idpAuthenticatedAt: NOW,
  ...over,
});

// Text with control characters, spaces, astral characters and long runs, which is where
// limits go wrong.
const awkward = fc.string({
  unit: fc.oneof(
    fc.constantFrom('a', 'Z', ' ', '\t', '\n', '\u0000', '\u007f', '\u0085', '\u009f', ' '),
    fc.constantFrom('😀', '𝔸', 'é', '​'),
    fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
  ),
  maxLength: 400,
});

describe('VerifiedIdentity limits', () => {
  it('takes a subject exactly when it has 1 to 255 code points and no control character', () => {
    fc.assert(
      fc.property(awkward, (subject) => {
        const minted = mintVerifiedIdentity(claims({ subject }), NOW);
        const valid =
          points(subject) >= 1 && points(subject) <= SUBJECT_MAX && !CONTROL.test(subject);
        expect(minted !== null).toBe(valid);
        // Never trimmed: a subject is an identifier, so a changed one is a different person.
        if (minted !== null) expect(minted.subject).toBe(subject);
      }),
      runs,
    );
  });

  it('refuses a subject at 256 code points and takes one at 255', () => {
    expect(mintVerifiedIdentity(claims({ subject: '😀'.repeat(255) }), NOW)?.subject).toBe(
      '😀'.repeat(255),
    );
    expect(mintVerifiedIdentity(claims({ subject: 'a'.repeat(256) }), NOW)).toBeNull();
    expect(mintVerifiedIdentity(claims({ subject: '' }), NOW)).toBeNull();
  });

  it('trims a display name to 120 code points with no control character, or none', () => {
    fc.assert(
      fc.property(fc.option(awkward, { nil: null }), (displayName) => {
        const minted = mintVerifiedIdentity(claims({ displayName }), NOW);
        expect(minted).not.toBeNull();
        const name = minted?.displayName ?? null;
        expect(name).toBe(cleanDisplayName(displayName));
        if (name === null) return;
        expect(points(name)).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
        expect(points(name)).toBeGreaterThan(0);
        expect(CONTROL.test(name)).toBe(false);
        expect(name).toBe(name.trim());
        // Cleaning a clean name changes nothing.
        expect(cleanDisplayName(name)).toBe(name);
      }),
      runs,
    );
  });

  it('keeps a short clean display name as it is', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z .'-]{0,100}[A-Za-z]$/), (displayName) => {
        expect(mintVerifiedIdentity(claims({ displayName }), NOW)?.displayName).toBe(displayName);
      }),
      runs,
    );
  });

  it('clamps the IdP time into the last day, and keeps one inside it', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10 * DAY_MS, max: 10 * DAY_MS }), (offset) => {
        const at = new Date(NOW.getTime() + offset);
        const minted = mintVerifiedIdentity(claims({ idpAuthenticatedAt: at }), NOW);
        const time = minted?.idpAuthenticatedAt.getTime() ?? Number.NaN;
        expect(time).toBeGreaterThanOrEqual(NOW.getTime() - DAY_MS);
        expect(time).toBeLessThanOrEqual(NOW.getTime());
        if (offset <= 0 && offset >= -DAY_MS) expect(time).toBe(at.getTime());
      }),
      runs,
    );
  });

  it.each([
    ['an invalid time', { idpAuthenticatedAt: new Date(Number.NaN) }],
    ['an address that does not normalize', { email: 'not an address' }],
    ['an organization id that is not one', { organizationId: 'org_nope' }],
    ['a connection id that is not one', { connectionId: '' }],
    ['an unknown protocol', { protocol: 'ldap' }],
    ['an unknown claim', { groups: ['admins'] }],
  ])('refuses %s', (_label, over) => {
    expect(mintVerifiedIdentity(claims(over) as never, NOW)).toBeNull();
  });

  it('marks only what it minted, so a copy is not an identity', () => {
    const minted = mintVerifiedIdentity(claims(), NOW);
    expect(isVerifiedIdentity(minted)).toBe(true);
    expect(Object.isFrozen(minted)).toBe(true);
    expect(isVerifiedIdentity({ ...minted })).toBe(false);
    expect(isVerifiedIdentity(null)).toBe(false);
    expect(isVerifiedIdentity('identity')).toBe(false);
  });

  it('normalizes the address', () => {
    expect(mintVerifiedIdentity(claims({ email: 'Ada@Example.COM' }), NOW)?.email).toBe(
      'ada@example.com',
    );
  });
});

describe('the seat check', () => {
  const limiter: RateLimiter = { keyFor: () => Buffer.alloc(32), reserve: () => Promise.resolve() };

  // Free holds five seats. Whatever was there before and in whatever order new people
  // arrive, just in time never takes the organization past them.
  it('is never exceeded under generated orderings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 6 }),
        fc.nat({ max: 3 }),
        fc.array(fc.constantFrom('new', 'again'), { minLength: 1, maxLength: 12 }),
        async (members, invitations, arrivals) => {
          const config = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: 'open' });
          const fake = ssoStore({
            connection: {
              id: CONN,
              status: 'active',
              jit_enabled: true,
              jit_default_project_role: null,
              display_name: 'Okta',
            },
            domains: ['example.com'],
            tier: 'free',
          });
          for (let i = 0; i < members; i += 1) {
            fake.tables.memberships.push({ id: randomUUID(), user_id: randomUUID() });
          }
          for (let i = 0; i < invitations; i += 1) {
            fake.tables.invitations.push({
              id: randomUUID(),
              email_normalized: `inv${String(i)}@other.test`,
            });
          }
          const started: StartSessionInput[] = [];
          const sso = createSsoSignIn(config, {
            store: fake.store,
            logger: logRecorder().logger,
            mailer: createTestAuthMailer().mailer,
            limiter,
            sessions: {
              startSession: (_b, input) => {
                started.push(input);
                return Promise.reject(new Error('stop after the decision'));
              },
            },
          });
          const before = members + invitations;
          const people = new Set<number>();
          let n = 0;
          for (const arrival of arrivals) {
            if (arrival === 'new') n += 1;
            people.add(Math.max(n, 1));
            const identity = mintVerifiedIdentity({
              protocol: 'saml',
              organizationId: organizationId(ORG),
              connectionId: idOf('ssc', CONN),
              subject: `s${String(Math.max(n, 1))}`,
              email: `p${String(Math.max(n, 1))}@example.com`,
              displayName: null,
              idpAuthenticatedAt: NOW,
            });
            if (identity === null) throw new Error('fixture');
            await sso.signInWithVerifiedIdentity(new Jar().context(), identity, '/');
            const used = fake.tables.memberships.length + fake.tables.invitations.length;
            expect(used).toBeLessThanOrEqual(Math.max(before, 5));
          }
          // Everyone who got past the seat check holds a seat, and nobody holds two.
          const joined = fake.tables.memberships.length - members;
          expect(new Set(started.map((s) => s.userId)).size).toBe(joined);
          expect(joined).toBe(Math.min(Math.max(5 - before, 0), people.size));
        },
      ),
      { ...runs, numRuns: 100 },
    );
  });
});
