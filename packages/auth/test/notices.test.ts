import { describe, expect, it } from 'vitest';
import { INVITER_FALLBACK, plainInviterName } from '../src/invitations.ts';
import { UNNAMED_PERSON, memberName } from '../src/notices.ts';

const ADDRESS = 'nia@example.com';

const REFUSED_NAMES: readonly (readonly [string, string | null])[] = [
  ['no name', null],
  ['an empty name', ''],
  ['a blank name', '   '],
  ['a bidi override', 'Ada‮Lovelace'],
  ['a newline', 'Ada\nLovelace'],
  ['a zero width space', 'Ada​Lovelace'],
  ['a joiner', 'Ada‍Lovelace'],
  ['a scheme', 'Acme Security http://evil.example/login'],
  ['a www prefix', 'www.evil.example'],
  ['a domain', 'evil.example'],
  ['a full width dot', 'evil．example'],
  ['a lone surrogate', 'Ada\ud800'],
  ['101 characters', 'a'.repeat(101)],
];

describe('memberName', () => {
  it.each(REFUSED_NAMES)('falls back to the address for %s', (_label, name) => {
    expect(memberName(name, ADDRESS)).toBe(ADDRESS);
  });

  it('keeps a clean name, in the form it passed the rule', () => {
    expect(memberName('  Nia Newcomer ', ADDRESS)).toBe('Nia Newcomer');
    expect(memberName('Ｎｉａ', ADDRESS)).toBe('Nia');
  });

  it('shows a plain dotted address', () => {
    expect(memberName(null, 'first.last@example.com')).toBe('first.last@example.com');
  });

  it.each([
    'www.evil.example/login?a=@attacker.example',
    'a_www.evil.example@attacker.example',
    'evil.example/x@attacker.example',
    'a%2f@attacker.example',
  ])('gives the fixed text for the link shaped address %s', (address) => {
    expect(memberName(null, address)).toBe('A team member');
    expect(memberName('http://evil.example', address)).toBe(UNNAMED_PERSON);
  });
});

describe('naming a person', () => {
  it('uses one fixed text for inviters and members', () => {
    expect(UNNAMED_PERSON).toBe('A team member');
    expect(INVITER_FALLBACK).toBe(UNNAMED_PERSON);
  });

  it.each(REFUSED_NAMES)('refuses %s for inviters and members alike', (_label, name) => {
    expect(plainInviterName(name)).toBe(INVITER_FALLBACK);
    expect(memberName(name, ADDRESS)).toBe(ADDRESS);
  });

  it.each(['Nia Newcomer', ' Ada ', 'Acme Inc.', 'Ünï'])('keeps %j for both', (name) => {
    expect(memberName(name, ADDRESS)).toBe(plainInviterName(name));
  });
});
