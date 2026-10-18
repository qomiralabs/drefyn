import { describe, expect, it } from 'vitest';
import {
  TenancyError,
  idOf,
  organizationId,
  parsePublicId,
  projectId,
  toPublicId,
  type OrganizationId,
} from '../src/index.ts';
import { MAX_UUID, NIL_UUID, PREFIXES, expectCode } from './support.ts';

// The published ULID example and its UUID form; decoded with BigInt to cross check.
const ULID_UUID = '01563e3a-b5d3-d676-4c61-efb99302bd5b';
const ULID_BODY = '01arz3ndektsv4rrffq69g5fav';

const org = (): OrganizationId => organizationId(ULID_UUID);
const valid = `org_${ULID_BODY}`;

describe('toPublicId', () => {
  it('encodes a known vector', () => {
    expect(toPublicId('org', org())).toBe(valid);
    expect(toPublicId('prj', projectId(ULID_UUID))).toBe(`prj_${ULID_BODY}`);
  });

  it('encodes the bottom and top of the 128 bit range', () => {
    expect(toPublicId('org', organizationId(NIL_UUID))).toBe(`org_${'0'.repeat(26)}`);
    expect(toPublicId('org', organizationId(MAX_UUID))).toBe(`org_7${'z'.repeat(25)}`);
  });

  it.each(PREFIXES)('uses the %s prefix', (kind) => {
    expect(toPublicId(kind, idOf(kind, ULID_UUID))).toBe(`${kind}_${ULID_BODY}`);
  });

  it('refuses an unbranded or malformed id smuggled past the types', () => {
    expectCode(() => toPublicId('org', 'not-a-uuid' as OrganizationId), 'ID_MALFORMED');
    expectCode(() => toPublicId('org', ULID_UUID.toUpperCase() as OrganizationId), 'ID_MALFORMED');
    expectCode(() => toPublicId('org', '' as OrganizationId), 'ID_MALFORMED');
  });

  it.each(['', 'ORG', 'xyz', '__proto__', 'constructor'])('refuses unknown kind %j', (kind) => {
    expectCode(() => toPublicId(kind as 'org', org()), 'ID_KIND_UNKNOWN');
  });
});

describe('parsePublicId', () => {
  it('decodes a known vector to the canonical UUID', () => {
    expect(parsePublicId('org', valid)).toBe(ULID_UUID);
  });

  it('decodes the bottom and top of the range', () => {
    expect(parsePublicId('prj', `prj_${'0'.repeat(26)}`)).toBe(NIL_UUID);
    expect(parsePublicId('prj', `prj_7${'z'.repeat(25)}`)).toBe(MAX_UUID);
  });

  it.each(PREFIXES.filter((p) => p !== 'org'))(
    'rejects a valid %s id where an org id is expected with ID_WRONG_TYPE',
    (other) => {
      expectCode(() => parsePublicId('org', `${other}_${ULID_BODY}`), 'ID_WRONG_TYPE');
    },
  );

  it('rejects an org id where a project id is expected with ID_WRONG_TYPE', () => {
    expectCode(() => parsePublicId('prj', valid), 'ID_WRONG_TYPE');
  });

  const malformed: readonly [string, unknown][] = [
    ['empty', ''],
    ['prefix only', 'org_'],
    ['body only', ULID_BODY],
    ['no separator', `org${ULID_BODY}`],
    ['hyphen separator', `org-${ULID_BODY}`],
    ['double separator', `org__${ULID_BODY}`],
    ['separator at the end', `${valid}_`],
    ['25 symbols', `org_${ULID_BODY.slice(1)}`],
    ['27 symbols', `org_${ULID_BODY}0`],
    ['52 symbols', `org_${ULID_BODY}${ULID_BODY}`],
    ['uppercase body', `org_${ULID_BODY.toUpperCase()}`],
    ['one uppercase symbol', `org_${ULID_BODY.slice(0, 5)}Z${ULID_BODY.slice(6)}`],
    ['uppercase prefix', `ORG_${ULID_BODY}`],
    ['letter i (Crockford alias of 1)', `org_${ULID_BODY.slice(0, 25)}i`],
    ['letter l (Crockford alias of 1)', `org_${ULID_BODY.slice(0, 25)}l`],
    ['letter o (Crockford alias of 0)', `org_${ULID_BODY.slice(0, 25)}o`],
    ['letter u (excluded)', `org_${ULID_BODY.slice(0, 25)}u`],
    [
      'hyphen in body (Crockford allows it)',
      `org_${ULID_BODY.slice(0, 13)}-${ULID_BODY.slice(13)}`,
    ],
    ['punctuation', `org_${ULID_BODY.slice(0, 25)}!`],
    ['first symbol 8, over 128 bits', `org_8${ULID_BODY.slice(1)}`],
    ['first symbol 9', `org_9${ULID_BODY.slice(1)}`],
    ['first symbol a', `org_a${ULID_BODY.slice(1)}`],
    ['first symbol z', `org_z${'z'.repeat(25)}`],
    ['leading space', ` ${valid}`],
    ['trailing space', `${valid} `],
    ['trailing newline', `${valid}\n`],
    ['nul byte', `${valid.slice(0, -1)}\u0000`],
    ['fullwidth symbol', `org_${ULID_BODY.slice(0, 25)}\uff5a`],
    ['cyrillic o in prefix', `\u043erg_${ULID_BODY}`],
    ['raw UUID', ULID_UUID],
    ['unknown prefix', `abc_${ULID_BODY}`],
    ['four letter prefix', `orgs_${ULID_BODY}`],
    ['two letter prefix', `or_${ULID_BODY}`],
    ['prototype key prefix', `__proto___${ULID_BODY}`],
    ['wrong prefix and bad body', `prj_${ULID_BODY.slice(1)}`],
    ['wrong prefix and over 128 bits', `prj_8${ULID_BODY.slice(1)}`],
    ['a megabyte', `org_${'0'.repeat(1_000_000)}`],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['boxed string', new String(valid)],
    ['object with toString', { toString: () => valid }],
  ];

  it.each(malformed)('rejects %s with ID_MALFORMED', (_label, value) => {
    expectCode(() => parsePublicId('org', value as string), 'ID_MALFORMED');
  });

  it('does not echo rejected input in the error message', () => {
    let message = '';
    try {
      parsePublicId('org', `org_${'<b>'.repeat(100)}`);
    } catch (error) {
      expect(error).toBeInstanceOf(TenancyError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('<b>');
    expect(message.length).toBeLessThan(200);
  });

  it.each(['', 'ORG', 'xyz', '__proto__'])('refuses unknown kind %j', (kind) => {
    expectCode(() => parsePublicId(kind as 'org', valid), 'ID_KIND_UNKNOWN');
  });
});
