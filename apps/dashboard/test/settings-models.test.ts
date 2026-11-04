import { describe, expect, it } from 'vitest';
import { browserName } from '../src/settings/browser-name.ts';
import {
  dayWords,
  filterPeople,
  invitePermit,
  keyFiltersFrom,
  keyFilterSearch,
  keyListInput,
  methodsFrom,
  needsTypedName,
  projectAccessWords,
  projectWords,
  roleOptions,
  scopeWords,
  seatSentence,
  seatsFrom,
  stepUpWays,
  usedWords,
  type PersonRow,
} from '../src/settings/models.ts';
import { problemWords, settle } from '../src/settings/results.ts';

const NOW = '2026-10-31T12:00:00.000Z';

describe('seats', () => {
  it('reads the limit from what entitlements said', () => {
    expect(seatsFrom({ used: 5, limit: 10 })).toEqual({
      used: 5,
      limit: 10,
      words: '5 of 10',
      state: 'room',
    });
  });

  it('says full at the limit and over past it', () => {
    expect(seatsFrom({ used: 10, limit: 10 }).state).toBe('full');
    expect(seatsFrom({ used: 12, limit: 10 }).state).toBe('over');
  });

  it('counts with no limit when the plan has none', () => {
    expect(seatsFrom({ used: 40, limit: 'unlimited' })).toEqual({
      used: 40,
      limit: null,
      words: '40 used',
      state: 'room',
    });
  });

  it('answers with the people, the waiting and the seats', () => {
    expect(seatSentence('Acme', 4, 1, seatsFrom({ used: 5, limit: 10 }))).toEqual({
      claim: '4 people in Acme, 1 invitation waiting.',
      rest: '5 of 10 seats used.',
    });
    expect(seatSentence('Acme', 1, 0, seatsFrom({ used: 1, limit: 3 }))).toEqual({
      claim: '1 person in Acme.',
      rest: '1 of 3 seats used.',
    });
    expect(seatSentence('Acme', 9, 1, seatsFrom({ used: 10, limit: 10 })).rest).toBe(
      'All 10 seats are used.',
    );
    expect(seatSentence('Acme', 12, 0, seatsFrom({ used: 12, limit: 10 })).rest).toBe(
      '12 of 10 seats used, so new invitations are paused.',
    );
    expect(seatSentence('Acme', 40, 2, seatsFrom({ used: 42, limit: 'unlimited' })).rest).toBe(
      '42 seats used.',
    );
  });

  it('allows an invitation only with a free seat, and says why not', () => {
    expect(invitePermit(seatsFrom({ used: 1, limit: 2 }))).toEqual({ allowed: true });
    const full = invitePermit(seatsFrom({ used: 2, limit: 2 }));
    expect(!full.allowed && full.reason).toContain('All 2 seats are used.');
    const over = invitePermit(seatsFrom({ used: 3, limit: 2 }));
    expect(!over.allowed && over.reason).toContain('until 2 or fewer are used');
  });
});

describe('dates', () => {
  it('writes days in UTC so the server and the browser agree', () => {
    expect(dayWords('2026-10-03T23:30:00.000Z')).toBe('3 Oct');
    expect(dayWords('2026-10-03T23:30:00.000Z', true)).toBe('3 Oct 2026');
  });

  it('says when something was last used, relative to now', () => {
    expect(usedWords(null, NOW)).toBe('Never');
    expect(usedWords('2026-10-31T09:12:00.000Z', NOW)).toBe('Today, 09:12 UTC');
    expect(usedWords('2026-10-30T09:12:00.000Z', NOW)).toBe('Yesterday');
    expect(usedWords('2026-10-28T09:12:00.000Z', NOW)).toBe('28 Oct');
  });
});

describe('API key filters', () => {
  const MEMBER = '01890a5d-ac96-774b-bcce-b302099a8100';

  it('reads each filter from the URL', () => {
    expect(
      keyFiltersFrom({
        q: 'deploy',
        can: 'docs,status',
        by: `${MEMBER},former`,
        used: '7d',
        after: 'abc',
      }),
    ).toEqual({
      search: 'deploy',
      products: ['docs', 'status'],
      createdBy: [MEMBER, 'former'],
      lastUsed: '7d',
      cursor: 'abc',
    });
  });

  it('drops what it does not know instead of failing the page', () => {
    expect(keyFiltersFrom({ can: 'nope', by: 'not-an-id', used: 'soon', q: ['a', 'b'] })).toEqual({
      products: [],
      createdBy: [],
      lastUsed: 'any',
    });
  });

  it('caps the search at the longest the list accepts', () => {
    expect(keyFiltersFrom({ q: 'x'.repeat(200) }).search).toHaveLength(100);
  });

  it('writes the URL back, leaving defaults out', () => {
    expect(
      keyFilterSearch({
        search: 'ci',
        products: ['docs'],
        createdBy: ['former'],
        lastUsed: 'never',
      }),
    ).toBe('?q=ci&can=docs&by=former&used=never');
    expect(keyFilterSearch({ products: [], createdBy: [], lastUsed: 'any' })).toBe('');
  });
});

describe('the list input', () => {
  it('sends no filter that is not set, since the list refuses an empty one', () => {
    expect(keyListInput({ products: [], createdBy: [], lastUsed: 'any' })).toEqual({
      lastUsed: 'any',
    });
  });

  it('passes every filter that is set', () => {
    expect(
      keyListInput({
        search: 'ci',
        products: ['docs'],
        createdBy: ['former'],
        lastUsed: '7d',
        cursor: 'abc',
      }),
    ).toEqual({
      search: 'ci',
      products: ['docs'],
      createdBy: ['former'],
      lastUsed: '7d',
      cursor: 'abc',
    });
  });
});

describe('revoking', () => {
  it('asks for the name only if the key was used in the last 7 days', () => {
    expect(needsTypedName('2026-10-25T12:00:00.000Z', NOW)).toBe(true);
    expect(needsTypedName('2026-10-24T11:59:00.000Z', NOW)).toBe(false);
    expect(needsTypedName(null, NOW)).toBe(false);
  });
});

describe('words for a key', () => {
  it('names what a key can do in plain words', () => {
    expect(scopeWords(['docs:pages.read', 'docs:pages.publish'])).toBe('Read and publish pages');
    expect(scopeWords(['status:incidents.write'])).toBe('Write incidents');
    expect(scopeWords(['docs:pages.read', 'status:status.read'])).toBe('Read pages, read status');
    expect(scopeWords(['docs:gone.now'])).toBe('docs:gone.now');
  });

  it('names its projects when it may, and counts them when not', () => {
    const names = { p1: 'Payments API docs' };
    expect(projectWords('all', [], names)).toBe('All projects');
    expect(projectWords('listed', ['p1'], names)).toBe('Payments API docs');
    expect(projectWords('listed', ['p1', 'p2'], names)).toBe('2 projects');
    expect(projectWords('listed', ['p2'], names)).toBe('1 project');
  });
});

describe('people', () => {
  const row = (
    id: string,
    kind: PersonRow['kind'],
    name: string,
    role: PersonRow['role'],
    at: string,
  ): PersonRow => ({ id, kind, name, email: `${id}@acme.dev`, role, at });
  const people = [
    row('a', 'member', 'Maya', 'owner', '2026-10-01'),
    row('b', 'member', 'Sam', 'member', '2026-10-09'),
    row('c', 'invited', 'Jo', 'member', '2026-10-20'),
    row('d', 'expired', 'Old', 'admin', '2026-09-20'),
  ];
  const ids = (rows: readonly PersonRow[]) => rows.map((r) => r.id);
  const base = { search: '', roles: [], statuses: ['active', 'invited'], sort: 'name' } as const;

  it('shows active and invited by default, sorted by name', () => {
    expect(ids(filterPeople(people, base))).toEqual(['c', 'a', 'b']);
  });

  it('searches names and addresses', () => {
    expect(ids(filterPeople(people, { ...base, search: 'SAM' }))).toEqual(['b']);
    expect(ids(filterPeople(people, { ...base, search: 'a@acme' }))).toEqual(['a']);
  });

  it('filters by role and status together', () => {
    expect(ids(filterPeople(people, { ...base, roles: ['member'], statuses: ['active'] }))).toEqual(
      ['b'],
    );
    expect(ids(filterPeople(people, { ...base, statuses: ['expired'] }))).toEqual(['d']);
  });

  it('sorts by role and by when they joined', () => {
    expect(ids(filterPeople(people, { ...base, sort: 'role' }))).toEqual(['a', 'c', 'b']);
    expect(ids(filterPeople(people, { ...base, sort: 'newest' }))).toEqual(['c', 'b', 'a']);
    expect(ids(filterPeople(people, { ...base, sort: 'oldest' }))).toEqual(['a', 'b', 'c']);
  });

  it('keeps Owner away from an admin, with the reason', () => {
    const options = roleOptions({
      actor: 'admin',
      target: 'member',
      self: false,
      lastOwner: false,
    });
    expect(options.find((o) => o.role === 'owner')?.reason).toBe(
      'Only an owner can make someone an owner.',
    );
    expect(options.find((o) => o.role === 'admin')?.reason).toBeUndefined();
  });

  it('keeps the last owner an owner, with the reason', () => {
    const options = roleOptions(
      { actor: 'owner', target: 'owner', self: true, lastOwner: true },
      'Acme',
    );
    expect(options.find((o) => o.role === 'member')?.reason).toBe(
      'Acme needs at least one owner. Make someone else an owner first.',
    );
  });

  it('says what access someone has across projects', () => {
    expect(projectAccessWords('owner', null, [])).toBe('Admin on all');
    expect(projectAccessWords('member', 'viewer', [])).toBe('Viewer on all');
    expect(projectAccessWords('member', 'editor', ['admin'])).toBe('Editor on all, admin on 1');
    expect(projectAccessWords('member', null, [])).toBe('No projects yet');
    expect(projectAccessWords('member', null, ['viewer', 'editor'])).toBe('2 projects');
  });
});

describe('sign in methods', () => {
  const account = { passwordSetAt: null, identities: [] };

  it('counts email, a password and each linked provider', () => {
    expect(methodsFrom({ ...account, passwordSetAt: 'x' }, true)).toMatchObject({
      count: 2,
      only: false,
    });
  });

  it('marks the one way left, so it cannot be removed', () => {
    const identities = [{ provider: 'github', account: 'a', linkedAt: 'x' }] as const;
    expect(methodsFrom({ ...account, identities }, false)).toMatchObject({ count: 1, only: true });
  });

  it('offers ways to confirm it is you, and never GitHub beside others', () => {
    expect(stepUpWays({ password: true, email: true, google: true, github: true })).toEqual([
      'password',
      'email',
      'google',
    ]);
    expect(stepUpWays({ password: false, email: false, google: false, github: true })).toEqual([
      'github',
    ]);
    expect(stepUpWays({ password: false, email: true, google: false, github: true })).toEqual([
      'email',
    ]);
  });
});

describe('sessions', () => {
  it('names a browser from its user agent, and never echoes the string', () => {
    expect(browserName('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0', 'email')).toBe(
      'Firefox on macOS',
    );
    expect(browserName('curl/8', 'email')).toBe('Unknown browser');
    expect(browserName(null, 'email')).toBe('Unknown browser');
    expect(browserName(null, 'cli_link')).toBe('Command line');
  });
});

describe('settle', () => {
  it('passes an outcome through', () => {
    expect(settle({ ok: true, value: 1 })).toEqual({ ok: true, value: 1 });
  });

  it('reads a wrapper refusal as a failure with its code as the reference', () => {
    expect(settle({ ok: false, status: 403, code: 'auth.origin_refused' })).toEqual({
      ok: false,
      problem: { kind: 'failed', reference: 'auth.origin_refused' },
    });
  });
});

describe('problemWords', () => {
  it('has plain words for each kind of failure', () => {
    expect(problemWords({ kind: 'step_up' })).toContain('confirm it is you');
    expect(problemWords({ kind: 'limited', minutes: 1 })).toContain('1 minute.');
    expect(problemWords({ kind: 'limited', minutes: 3 })).toContain('3 minutes.');
    expect(problemWords({ kind: 'failed', reference: 'ref_1' })).toContain('ref_1');
    expect(problemWords({ kind: 'refused', code: 'AUTH_FORBIDDEN' })).toContain('cannot');
    expect(problemWords({ kind: 'refused', code: 'AUTH_SESSION_INVALID' })).toContain('Sign in');
  });
});
