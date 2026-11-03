import fc from 'fast-check';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { formatInvitationToken, parseInvitationToken, type Invitations } from '../src/index.ts';
import {
  formatBlockToken,
  invitationBlockLink,
  invitationLink,
  parseBlockToken,
  type BlockToken,
} from '../src/invitation-links.ts';
import { anyUuid, mutationsOf, runs, secretBytes } from './support.ts';

const ORIGINS = [
  'https://app.drefyn.test',
  'https://dashboard.example.com',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
] as const;

const origin = fc.constantFrom(...ORIGINS);
const orgId = anyUuid.map((u) => idOf('org', u));
const invId = anyUuid.map((u) => idOf('inv', u));
const token = fc
  .tuple(orgId, invId, secretBytes)
  .map(([organizationId, invitationId, secret]) =>
    formatInvitationToken({ organizationId, invitationId, secret }),
  );
const blockToken: fc.Arbitrary<BlockToken> = fc.record({
  organizationId: orgId,
  invitationId: invId,
  emailHmac: secretBytes.map((b) => Buffer.from(b)),
  expiresAt: fc.integer({ min: 1_000_000_000, max: 9_999_999_999 }),
  tag: secretBytes.map((b) => Buffer.from(b)),
});

describe('invitation links', () => {
  it('are <origin>/invite#<token>: fixed path, empty query, the token only in the fragment', () => {
    fc.assert(
      fc.property(origin, token, (o, t) => {
        const url = invitationLink(o, t);
        expect(url.origin).toBe(new URL(o).origin);
        expect(url.pathname).toBe('/invite');
        expect(url.search).toBe('');
        expect(url.hash).toBe(`#${t}`);
        expect(url.username + url.password).toBe('');
        expect(url.href).toBe(`${new URL(o).origin}/invite#${t}`);
        // The token appears once, after the #.
        expect(url.href.indexOf(t)).toBe(url.href.indexOf('#') + 1);
        expect(parseInvitationToken(url.hash.slice(1))).not.toBeNull();
      }),
      runs,
    );
  });

  it('are <origin>/invite/block#<block token> for the block link', () => {
    fc.assert(
      fc.property(origin, blockToken, (o, parts) => {
        const t = formatBlockToken(parts);
        const url = invitationBlockLink(o, t);
        expect(url.origin).toBe(new URL(o).origin);
        expect(url.pathname).toBe('/invite/block');
        expect(url.search).toBe('');
        expect(url.hash).toBe(`#${t}`);
        expect(url.href).toBe(`${new URL(o).origin}/invite/block#${t}`);
        expect(url.href.indexOf(t)).toBe(url.href.indexOf('#') + 1);
      }),
      runs,
    );
  });

  it('refuse a value that is not a token, so nothing else can land in the URL', () => {
    expect(() => invitationLink(ORIGINS[0], 'a/b?c#d')).toThrow(RangeError);
    expect(() => invitationBlockLink(ORIGINS[0], '../x')).toThrow(RangeError);
  });
});

describe('block tokens', () => {
  it('round trip every field', () => {
    fc.assert(
      fc.property(blockToken, (parts) => {
        const parsed = parseBlockToken(formatBlockToken(parts));
        expect(parsed).not.toBeNull();
        expect(parsed?.organizationId).toBe(parts.organizationId);
        expect(parsed?.invitationId).toBe(parts.invitationId);
        expect(parsed?.emailHmac.equals(parts.emailHmac)).toBe(true);
        expect(parsed?.expiresAt).toBe(parts.expiresAt);
        expect(parsed?.tag.equals(parts.tag)).toBe(true);
      }),
      runs,
    );
  });

  it('refuse every single character edit that is not another valid token', () => {
    const valid = formatBlockToken({
      organizationId: idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070'),
      invitationId: idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072'),
      emailHmac: Buffer.alloc(32, 3),
      expiresAt: 1_800_000_000,
      tag: Buffer.alloc(32, 4),
    });
    fc.assert(
      fc.property(mutationsOf(valid), (m) => {
        const parsed = parseBlockToken(m.value);
        if (parsed === null) return;
        // A substitution inside the alphabet can be another real token; never the same one.
        expect(m.value).not.toBe(valid);
        expect(formatBlockToken(parsed)).toBe(m.value);
      }),
      runs,
    );
  });

  it('refuse anything that is not a string', () => {
    for (const value of [undefined, null, 1, {}, new URL('https://app.drefyn.test/x')]) {
      expect(parseBlockToken(value)).toBeNull();
    }
  });
});

describe('the token enters the library only as a string', () => {
  it('in every function that takes one', () => {
    expectTypeOf<Parameters<Invitations['acceptInvitation']>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Invitations['blockInvitation']>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Invitations['readInvitationBlock']>[0]>().toEqualTypeOf<string>();
  });
});
