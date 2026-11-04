import type { AccessContext, AccessView } from '@drefyn/auth';
import { TIERS } from '@drefyn/entitlements';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SHELL } from '../src/fixtures/shell.ts';
import { PLAN_LABELS, initialsOf, shellDataFor } from '../src/server/shell-data.ts';

const VIEW: AccessView = {
  organizationSlug: 'beta',
  organizationName: 'Beta Labs',
  email: 'noor@beta.dev',
  displayName: 'Noor Haddad',
};
const ACCESS = { tier: 'growth' } as unknown as AccessContext;

describe('shellDataFor', () => {
  it('draws the real organization, plan and person, and keeps fixtures for the rest', () => {
    const data = shellDataFor({ access: ACCESS, view: VIEW });
    expect(data.organization).toEqual({ slug: 'beta', name: 'Beta Labs', plan: 'Growth' });
    expect(data.person).toEqual({ name: 'Noor Haddad', initials: 'NH', email: 'noor@beta.dev' });
    expect(data.seats).toBe(PLACEHOLDER_SHELL.seats);
    expect(data.inbox).toBe(PLACEHOLDER_SHELL.inbox);
    expect(data.projects).toBe(PLACEHOLDER_SHELL.projects);
  });

  it('falls back to the local part of the address', () => {
    const data = shellDataFor({ access: ACCESS, view: { ...VIEW, displayName: null } });
    expect(data.person.name).toBe('noor');
    expect(data.person.initials).toBe('N');
  });

  it('treats a blank name like none', () => {
    const data = shellDataFor({ access: ACCESS, view: { ...VIEW, displayName: '  ' } });
    expect(data.person.name).toBe('noor');
  });

  it('has a label for every tier', () => {
    for (const tier of TIERS) expect(PLAN_LABELS[tier]).not.toBe('');
  });
});

describe('initialsOf', () => {
  it.each([
    ['Maya Okafor', 'MO'],
    ['ada', 'A'],
    ['Mary Jane Watson', 'MW'],
    ['  spaced   out ', 'SO'],
    ['\u{1F600} smile', '\u{1F600}S'],
    ['', '?'],
  ])('%j is %s', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});
