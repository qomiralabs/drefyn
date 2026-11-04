import { describe, expect, it } from 'vitest';
import { checkMessage } from '../src/guards.ts';
import type { MailMessage } from '../src/index.ts';
import { AT, ORIGIN, invitation, notice } from './support.ts';

type Build = (name: string) => MailMessage;

const ZWJ = '\u200d';

const organizationNotice: Build = (n) =>
  notice({
    kind: 'api_key_created',
    at: AT,
    organizationName: n,
    keyName: 'ci',
    displaySuffix: 'x7qa',
  });

const OTHER_NAME_FIELDS: readonly (readonly [string, Build])[] = [
  ['organizationName', (n) => invitation({ organizationName: n })],
  ['inviterName', (n) => invitation({ inviterName: n })],
  ['notice.organizationName', organizationNotice],
  [
    'notice.keyName',
    (n) =>
      notice({
        kind: 'api_key_created',
        at: AT,
        organizationName: 'Acme',
        keyName: n,
        displaySuffix: 'x7qa',
      }),
  ],
  ['notice.method', (n) => notice({ kind: 'new_device_sign_in', at: AT, method: n })],
  ['notice.device', (n) => notice({ kind: 'new_device_sign_in', at: AT, device: n })],
];

const PERSON_FIELDS: readonly (readonly [string, Build])[] = [
  [
    'notice.ownerName',
    (n) => notice({ kind: 'owner_added', at: AT, organizationName: 'Acme', ownerName: n }),
  ],
  [
    'notice.memberName',
    (n) =>
      notice({
        kind: 'member_removed',
        at: AT,
        organizationName: 'Acme',
        memberName: n,
        revokedKeys: 0,
      }),
  ],
];

const ACCOUNT_FIELDS: readonly (readonly [string, Build])[] = [
  [
    'notice.account',
    (n) => notice({ kind: 'identity_linked', at: AT, provider: 'google', account: n }),
  ],
  [
    'linking.account',
    (n) => ({
      template: 'sign_in_code',
      purpose: 'link_identity',
      code: '12345678',
      link: new URL('/p', ORIGIN),
      expiresInMinutes: 10,
      linking: { provider: 'github', account: n },
    }),
  ],
];

const NAME_FIELDS = [...OTHER_NAME_FIELDS, ...PERSON_FIELDS];
const TEXT_FIELDS = [...NAME_FIELDS, ...ACCOUNT_FIELDS];

const LINKS = [
  'http://evil.example',
  'Acme Security http://evil.example/login',
  'www.evil.example',
  'evil.example',
  'evil\uff0eexample',
  'evil\u3002example',
  'evil\uff61example',
  `evil.${ZWJ}example`,
  `www${ZWJ}.evil.example`,
  `ht${ZWJ}tp://x`,
];
const HIDDEN = ['\u200b', '\ufeff', '\u00ad', '\u2060'];
const FAMILY = `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`;
const PLAIN_ADDRESSES = [
  'nia@example.com',
  'first.last@example.com',
  "o'neil@example.com",
  'a+tag@example.com',
];
const LINK_ADDRESSES = [
  'www.evil.example/login?a=@attacker.example',
  'a_www.evil.example@attacker.example',
  'evil.example/x@attacker.example',
  'a%2f@attacker.example',
];

const accepts = (message: MailMessage) => checkMessage(message, ORIGIN).ok;
const refusedField = (message: MailMessage) => {
  const result = checkMessage(message, ORIGIN);
  return result.ok ? 'accepted' : result.error.field;
};

describe.each(NAME_FIELDS)('the name field %s', (field, build) => {
  it.each(LINKS)('refuses the link %j', (text) => {
    expect(refusedField(build(text))).toBe(field);
  });

  it.each(LINK_ADDRESSES)('refuses the link shaped address %j', (text) => {
    expect(refusedField(build(text))).toBe(field);
  });

  it('keeps a family emoji and an ordinary name', () => {
    expect(accepts(build(FAMILY))).toBe(true);
    expect(accepts(build('Ada Lovelace'))).toBe(true);
  });
});

describe.each(TEXT_FIELDS)('the text field %s', (field, build) => {
  it.each(HIDDEN)('refuses the hidden character %j', (char) => {
    expect(refusedField(build(`Ada${char}Lovelace`))).toBe(field);
  });
});

describe.each(PERSON_FIELDS)('the person field %s', (_field, build) => {
  it.each(PLAIN_ADDRESSES)('accepts the plain address %j', (address) => {
    expect(accepts(build(address))).toBe(true);
  });
});

describe.each(OTHER_NAME_FIELDS)('the field %s, which never holds an address', (field, build) => {
  it.each(PLAIN_ADDRESSES)('refuses %j', (address) => {
    expect(refusedField(build(address))).toBe(field);
  });
});

describe.each(ACCOUNT_FIELDS)('the account field %s', (_field, build) => {
  it.each(PLAIN_ADDRESSES)('accepts %j, since it holds an address on purpose', (address) => {
    expect(accepts(build(address))).toBe(true);
  });
});

// The link check reads the value before it is cut, so a cut cannot hide what comes after.
describe('long names', () => {
  it('refuses a link past the point a name would be cut', () => {
    expect(refusedField(invitation({ organizationName: `${'a '.repeat(80)}evil.example` }))).toBe(
      'organizationName',
    );
  });
});
