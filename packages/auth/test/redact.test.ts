import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { idOf, organizationId } from '@drefyn/tenancy';
import {
  REDACTED,
  encodeSecret,
  formatApiKey,
  formatInvitationToken,
  formatSessionToken,
  redact,
  redactText,
} from '../src/index.ts';
import { UUID_A, UUID_B, anyUuid, runs, secretBytes } from './support.ts';

const sessionToken = fc
  .tuple(anyUuid, anyUuid, secretBytes)
  .map(([u, s, b]) => formatSessionToken({ userId: idOf('usr', u), sessionId: s, secret: b }));
const apiKey = fc
  .tuple(anyUuid, anyUuid, secretBytes)
  .map(([o, k, b]) =>
    formatApiKey({ organizationId: organizationId(o), keyId: idOf('key', k), secret: b }),
  );
const invitationToken = fc
  .tuple(anyUuid, anyUuid, secretBytes)
  .map(([o, i, b]) =>
    formatInvitationToken({ organizationId: organizationId(o), invitationId: i, secret: b }),
  );
const freeText = fc.string({
  unit: fc.constantFrom(...Array.from('abcdefghijklmnopqrstuvwxyz0123456789 -')),
  minLength: 12,
  maxLength: 30,
});
const code = fc.stringMatching(/^[0-9]{8}$/);
const state = secretBytes.map(encodeSecret);

// A secret kind, the value that must vanish, and how it shows up in a log object.
type Placement = readonly [secret: string, field: string, value: unknown];

const placements: fc.Arbitrary<Placement> = fc.oneof(
  freeText.chain((p) =>
    fc.constantFrom<Placement>(
      [p, 'password', p],
      [p, 'newPassword', p],
      [p, 'current_password', p],
      [p, 'PASSWORD', p],
    ),
  ),
  code.chain((c) => fc.constantFrom<Placement>([c, 'code', c], [c, 'emailCode', c], [c, 'otp', c])),
  state.chain((s) =>
    fc.constantFrom<Placement>([s, 'state', s], [s, 'pre', s], [s, 'oauthState', s]),
  ),
  code.map((c): Placement => [
    c,
    'url',
    `https://app.test/auth/oauth/github/callback?code=${c}&x=1`,
  ]),
  state.map((s): Placement => [s, 'url', `/auth/oauth/google/callback?x=1&state=${s}`]),
  invitationToken.chain((t) =>
    fc.constantFrom<Placement>(
      [t, 'invitation', t],
      [t, 'inviteToken', t],
      [t, 'message', `accepting ${t} now`],
      [t, 'url', `https://app.test/invite#${t}`],
    ),
  ),
  sessionToken.chain((t) =>
    fc.constantFrom<Placement>(
      [t, 'cookie', `__Host-drefyn_session=${t}`],
      [t, 'headers', { cookie: `a=b; __Host-drefyn_session=${t}; c=d` }],
      [t, 'setCookie', `drefyn_session=${t}; Path=/`],
      [t, 'detail', `session ${t} rejected`],
      [t, 'sessionToken', t],
    ),
  ),
  apiKey.chain((k) =>
    fc.constantFrom<Placement>(
      [k, 'authorization', `Bearer ${k}`],
      [k, 'headers', { Authorization: `Bearer ${k}` }],
      [k, 'apiKey', k],
      [k, 'error', `refused ${k}`],
      [k, 'argv', ['curl', '-H', `Authorization: Bearer ${k}`]],
    ),
  ),
);

// Wraps a value in objects and arrays to the given depth.
function nest(value: Record<string, unknown>, path: readonly (string | number)[]): unknown {
  return path.reduceRight<unknown>(
    (inner, step) => (typeof step === 'number' ? [inner] : { [step]: inner }),
    value,
  );
}

const path = fc.array(
  fc.oneof(fc.constantFrom('context', 'request', 'cause', 'meta'), fc.constant(0)),
  {
    maxLength: 40,
  },
);

describe('redact', () => {
  it('removes every secret kind at any depth', () => {
    fc.assert(
      fc.property(placements, path, ([secret, field, value], where) => {
        const log = {
          event: 'auth.test',
          organizationId: 'org_x',
          nested: nest({ [field]: value, kept: 'yes' }, where),
        };
        const out = redact(log);
        const text = JSON.stringify(out);
        expect(text).not.toContain(secret);
        expect(text).toContain('auth.test');
        expect(text).toContain('"kept":"yes"');
        expect(log.nested).toEqual(nest({ [field]: value, kept: 'yes' }, where));
      }),
      { ...runs, numRuns: 1000 },
    );
  });

  it('keeps ids, events and other fields as they are', () => {
    const log = {
      event: 'auth.sign_in',
      outcome: 'AUTH_CODE_INVALID',
      organizationId: UUID_A,
      sessionId: 'ses_01k7',
      count: 3,
      ok: false,
      when: null,
      list: [1, 'two'],
    };
    expect(redact(log)).toEqual(log);
  });

  it('redacts personal data keys, binary values and error messages', () => {
    const key = formatApiKey({
      organizationId: organizationId(UUID_A),
      keyId: idOf('key', UUID_B),
      secret: new Uint8Array(32).fill(1),
    });
    const error = new Error(`could not verify ${key}`);
    const out = redact({
      email: 'jane@example.com',
      ip: '203.0.113.9',
      secretHash: Buffer.from('abc'),
      bytes: new Uint8Array([1, 2]),
      err: error,
    }) as Record<string, unknown>;
    expect(out['email']).toBe(REDACTED);
    expect(out['ip']).toBe(REDACTED);
    expect(out['secretHash']).toBe(REDACTED);
    expect(out['bytes']).toBe(REDACTED);
    const err = out['err'] as Record<string, unknown>;
    expect(err['name']).toBe('Error');
    expect(String(err['message'])).not.toContain(key);
    expect(String(err['stack'])).not.toContain(key);
  });

  it('survives cycles, maps, sets, dates and very deep values without leaking', () => {
    const token = formatSessionToken({
      userId: idOf('usr', UUID_A),
      sessionId: UUID_B,
      secret: new Uint8Array(32).fill(2),
    });
    const cyclic: Record<string, unknown> = { password: 'hunter2hunter2' };
    cyclic['self'] = cyclic;
    const when = new Date(0);
    let deep: unknown = { token };
    for (let i = 0; i < 5000; i += 1) deep = { deeper: deep };
    const out = redact({
      cyclic,
      map: new Map([['cookie', `__Host-drefyn_session=${token}`]]),
      set: new Set([`v ${token}`]),
      when,
      deep,
    });
    const text = JSON.stringify(out, (_, v: unknown) =>
      v instanceof Map
        ? (Object.fromEntries(v) as unknown)
        : v instanceof Set
          ? (Array.from(v) as unknown)
          : v,
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[circular]');
    expect((out as Record<string, unknown>)['when']).toBe(when);
  });

  it('passes primitives through and redacts secrets in a bare string', () => {
    expect(redact(5)).toBe(5);
    expect(redact(undefined)).toBeUndefined();
    expect(redact('plain words')).toBe('plain words');
  });
});

describe('redactText', () => {
  it('removes token shaped values from free text', () => {
    fc.assert(
      fc.property(
        fc.oneof(sessionToken, apiKey, invitationToken),
        freeText,
        freeText,
        (secret, before, after) => {
          const out = redactText(`${before}${secret}${after}`);
          expect(out).not.toContain(secret);
          expect(out).toContain(REDACTED);
        },
      ),
      runs,
    );
  });

  it('removes the OAuth code and state from a query string, and cookie values by name', () => {
    expect(redactText('/cb?code=abc123&state=xyz789&ok=1')).toBe(
      `/cb?code=${REDACTED}&state=${REDACTED}&ok=1`,
    );
    expect(redactText('__Host-drefyn_pre=abcdef; theme=dark')).toBe(
      `__Host-drefyn_pre=${REDACTED}; theme=dark`,
    );
    expect(redactText('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${REDACTED}`);
  });
});
