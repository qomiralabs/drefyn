import type { OrganizationSummary, SessionInfo, SignUpMode } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const jar = { get: vi.fn<(n: string) => { value: string } | undefined>() };
const readAccount = vi.fn();
const readInvitation = vi.fn();

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));
vi.mock('../src/server/origin.ts', () => ({ appOrigin: () => ORIGIN }));
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () =>
    Promise.resolve({ account: { readAccount }, invitations: { readInvitation } }),
  authConfig: () => ({ cookies: { invite: 'invite' } }),
}));

const { arrival, heldInvitation, instead, landing, mayCreateOrganization } =
  await import('../src/server/first-run.ts');

const SESSION = { email: 'Maya@Acme.dev' } as unknown as SessionInfo;
const ACME = { slug: 'acme' } as unknown as OrganizationSummary;
const named = (displayName: string | null) => ({ ok: true, value: { displayName } });

beforeEach(() => {
  vi.clearAllMocks();
  jar.get.mockReturnValue(undefined);
  readAccount.mockResolvedValue(named('Maya'));
});

describe('landing', () => {
  it('asks for a name before anything else', () => {
    expect(landing({ organizations: [], account: { displayName: null } })).toBe('/welcome');
    expect(landing({ organizations: [ACME], account: { displayName: null } })).toBe('/welcome');
  });

  it('opens the first organization', () => {
    expect(landing({ organizations: [ACME], account: { displayName: 'M' } })).toBe('/acme');
  });

  it('sends a named person with no organization to the organization page', () => {
    expect(landing({ organizations: [], account: { displayName: 'M' } })).toBe(
      '/organizations/new',
    );
  });
});

describe('mayCreateOrganization', () => {
  it.each([
    ['open', true],
    ['invite_only', false],
    ['closed', false],
  ] as const)('%s is %s', (mode, allowed) => {
    expect(mayCreateOrganization(mode)).toBe(allowed);
  });
});

// Each page's own rule, followed from / the way a browser would. A loop or a 404 in any
// combination is the dead end this exists to rule out.
describe('every person, from /', () => {
  const MODES: readonly SignUpMode[] = ['open', 'invite_only', 'closed'];
  const NAMES = [null, 'Maya'];
  const LISTS = [[], [ACME]];
  const REDIRECT_LIMIT = 3;

  function walk(person: Parameters<typeof landing>[0], mode: SignUpMode): string {
    let path = landing(person);
    for (let hop = 0; hop < REDIRECT_LIMIT; hop += 1) {
      if (path !== '/welcome' && path !== '/organizations/new') return path;
      const next = instead(path, person, mode);
      if (next === null) return path;
      path = next === '/' ? landing(person) : next;
    }
    throw new Error(`loop at ${path}`);
  }

  for (const mode of MODES) {
    for (const displayName of NAMES) {
      for (const organizations of LISTS) {
        it(`${mode}, ${displayName ?? 'no name'}, ${organizations.length} organizations`, () => {
          const person = { organizations, account: { displayName } };
          const stop = walk(person, mode);
          if (displayName === null) expect(stop).toBe('/welcome');
          else if (organizations.length > 0) expect(stop).toBe('/acme');
          else expect(stop).toBe('/organizations/new');
        });
      }
    }
  }
});

describe('instead', () => {
  const person = (displayName: string | null, organizations = [ACME]) => ({
    organizations,
    account: { displayName },
  });

  it('keeps someone unnamed on Welcome, and sends the named on', () => {
    expect(instead('/welcome', person(null), 'open')).toBeNull();
    expect(instead('/welcome', person('M'), 'open')).toBe('/');
  });

  it('asks for a name before the organization page', () => {
    expect(instead('/organizations/new', person(null), 'open')).toBe('/welcome');
  });

  it('shows the organization page to anyone with no organization, whatever the mode', () => {
    expect(instead('/organizations/new', person('M', []), 'closed')).toBeNull();
    expect(instead('/organizations/new', person('M', []), 'open')).toBeNull();
  });

  it('opens the form to a member only where they may use it', () => {
    expect(instead('/organizations/new', person('M'), 'open')).toBeNull();
    expect(instead('/organizations/new', person('M'), 'invite_only')).toBe('/acme');
  });
});

describe('arrival', () => {
  it('sends an unnamed person to Welcome and keeps where they were going', async () => {
    readAccount.mockResolvedValue(named(null));
    await expect(arrival(SESSION, '/invite')).resolves.toBe('/welcome?next=%2Finvite');
    await expect(arrival(SESSION, '/acme?tab=a')).resolves.toBe('/welcome?next=%2Facme%3Ftab%3Da');
  });

  it('lets a named person through', async () => {
    await expect(arrival(SESSION, '/acme')).resolves.toBe('/acme');
  });

  it('leaves / to the page, with no read', async () => {
    await expect(arrival(SESSION, '/')).resolves.toBe('/');
    expect(readAccount).not.toHaveBeenCalled();
  });

  it('stays on this origin', async () => {
    await expect(arrival(SESSION, 'https://evil.example/')).resolves.toBe('/');
  });

  it('never fails a sign in over a read', async () => {
    readAccount.mockResolvedValue({ ok: false, error: new Error('down') });
    await expect(arrival(SESSION, '/acme')).resolves.toBe('/acme');
  });
});

describe('heldInvitation', () => {
  const OPEN = {
    ok: true,
    value: { email: 'maya@acme.dev', organizationName: 'Acme', inviterName: 'Priya Shah' },
  };

  it('is nothing with no cookie, and asks nobody', async () => {
    await expect(heldInvitation(SESSION)).resolves.toBeNull();
    expect(readInvitation).not.toHaveBeenCalled();
  });

  it('names the organization and the inviter for the right person', async () => {
    jar.get.mockReturnValue({ value: 'token' });
    readInvitation.mockResolvedValue(OPEN);
    await expect(heldInvitation(SESSION)).resolves.toEqual({
      organizationName: 'Acme',
      inviterName: 'Priya Shah',
    });
    expect(jar.get).toHaveBeenCalledWith('invite');
  });

  it('keeps quiet about a token that no longer works', async () => {
    jar.get.mockReturnValue({ value: 'token' });
    readInvitation.mockResolvedValue({ ok: false, error: new Error('gone') });
    await expect(heldInvitation(SESSION)).resolves.toBeNull();
  });

  it('keeps quiet about an invitation for someone else on this browser', async () => {
    jar.get.mockReturnValue({ value: 'token' });
    readInvitation.mockResolvedValue({ ...OPEN, value: { ...OPEN.value, email: 'b@acme.dev' } });
    await expect(heldInvitation(SESSION)).resolves.toBeNull();
  });
});
