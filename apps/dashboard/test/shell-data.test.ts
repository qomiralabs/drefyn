import type { AccessContext, AccessView, OrganizationSeats, ReachableProject } from '@drefyn/auth';
import { TIERS } from '@drefyn/entitlements';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listReachableProjects = vi.fn();
const listMyOrganizationSeats = vi.fn();
const logWarn = vi.fn();
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () =>
    Promise.resolve({
      members: { listReachableProjects },
      organizations: { listMyOrganizationSeats },
    }),
}));
vi.mock('../src/server/log.ts', () => ({ logWarn }));

const { PLAN_LABELS, initialsOf, shellDataFor, readShell } =
  await import('../src/server/shell-data.ts');

const VIEW: AccessView = {
  organizationSlug: 'beta',
  organizationName: 'Beta Labs',
  email: 'noor@beta.dev',
  displayName: 'Noor Haddad',
};
const ACCESS = { organizationId: 'org-beta', tier: 'growth' } as unknown as AccessContext;
const BETA = {
  role: 'owner',
  readOnlySince: null,
  organizationId: 'org-beta',
  slug: 'beta',
  name: 'Beta Labs',
  tier: 'growth',
  seats: { used: 3, limit: 20 },
} as unknown as OrganizationSeats;
const GAMMA = {
  ...BETA,
  organizationId: 'org-gamma',
  slug: 'gamma',
  name: 'Gamma',
  tier: 'self_hosted',
  seats: { used: 9, limit: 'unlimited' },
} as OrganizationSeats;
const COUNTLESS = { ...GAMMA, slug: 'delta', name: 'Delta', seats: null };
const HANDBOOK = {
  projectId: 'p1',
  slug: 'handbook',
  name: 'Handbook',
  product: 'docs',
  readOnly: false,
} as unknown as ReachableProject;
const NONE = { organizations: [], projects: [] };

describe('shellDataFor', () => {
  it('draws the organization, plan and person from what was read', () => {
    const data = shellDataFor({ access: ACCESS, view: VIEW }, NONE);
    expect(data.organization).toEqual({ slug: 'beta', name: 'Beta Labs', plan: 'Growth' });
    expect(data.person).toEqual({ name: 'Noor Haddad', initials: 'NH', email: 'noor@beta.dev' });
  });

  it('counts the seats of this organization and no other', () => {
    const data = shellDataFor(
      { access: ACCESS, view: VIEW },
      { organizations: [GAMMA, BETA], projects: [] },
    );
    expect(data.seats).toEqual({ used: 3, limit: 20 });
  });

  it('has no seat count when the read gave none', () => {
    expect(shellDataFor({ access: ACCESS, view: VIEW }, NONE).seats).toBeNull();
  });

  it('lists the organizations with plan and seats, for the menu', () => {
    const data = shellDataFor(
      { access: ACCESS, view: VIEW },
      { organizations: [BETA, GAMMA, COUNTLESS], projects: [] },
    );
    expect(data.organizations).toEqual([
      { slug: 'beta', name: 'Beta Labs', detail: 'Growth, 3 of 20 seats' },
      { slug: 'gamma', name: 'Gamma', detail: 'Self hosted, 9 seats' },
      { slug: 'delta', name: 'Delta', detail: 'Self hosted' },
    ]);
  });

  it('gives the client only the projects read, by product and slug, with no ids', () => {
    const data = shellDataFor(
      { access: ACCESS, view: VIEW },
      { organizations: [], projects: [HANDBOOK] },
    );
    expect(data.projects).toEqual({ 'docs/handbook': { name: 'Handbook', product: 'docs' } });
    expect(JSON.stringify(data)).not.toContain('p1');
  });

  it('keeps projects with one slug in two products apart', () => {
    const status = { ...HANDBOOK, product: 'status', name: 'Handbook status' } as ReachableProject;
    const data = shellDataFor(
      { access: ACCESS, view: VIEW },
      { organizations: [], projects: [HANDBOOK, status] },
    );
    expect(Object.keys(data.projects).toSorted()).toEqual(['docs/handbook', 'status/handbook']);
  });

  it('has an empty inbox, since nothing feeds one yet', () => {
    expect(shellDataFor({ access: ACCESS, view: VIEW }, NONE).inbox).toEqual([]);
  });

  it('falls back to the local part of the address', () => {
    const data = shellDataFor({ access: ACCESS, view: { ...VIEW, displayName: null } }, NONE);
    expect(data.person.name).toBe('noor');
    expect(data.person.initials).toBe('N');
  });

  it('treats a blank name like none', () => {
    const data = shellDataFor({ access: ACCESS, view: { ...VIEW, displayName: '  ' } }, NONE);
    expect(data.person.name).toBe('noor');
  });

  it('has a label for every tier', () => {
    for (const tier of TIERS) expect(PLAN_LABELS[tier]).not.toBe('');
  });
});

describe('readShell', () => {
  beforeEach(() => {
    listReachableProjects.mockReset();
    listMyOrganizationSeats.mockReset();
    logWarn.mockReset();
  });

  it('reads with the access context and draws what came back', async () => {
    listReachableProjects.mockResolvedValue({ ok: true, value: [HANDBOOK] });
    listMyOrganizationSeats.mockResolvedValue([BETA]);
    const data = await readShell({ access: ACCESS, view: VIEW });
    expect(listReachableProjects).toHaveBeenCalledWith(ACCESS);
    expect(listMyOrganizationSeats).toHaveBeenCalledWith(ACCESS);
    expect(data.seats).toEqual({ used: 3, limit: 20 });
    expect(Object.keys(data.projects)).toEqual(['docs/handbook']);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('keeps the shell standing when a read fails, and logs ids only', async () => {
    listReachableProjects.mockRejectedValue(new Error('secret detail'));
    listMyOrganizationSeats.mockRejectedValue(new Error('secret detail'));
    const data = await readShell({ access: ACCESS, view: VIEW });
    expect(data.seats).toBeNull();
    expect(data.projects).toEqual({});
    expect(data.organization.name).toBe('Beta Labs');
    expect(logWarn).toHaveBeenCalledWith('dashboard.shell_read_failed', {
      organizationId: 'org-beta',
      part: 'projects',
    });
    expect(logWarn).toHaveBeenCalledWith('dashboard.shell_read_failed', {
      organizationId: 'org-beta',
      part: 'organizations',
    });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('secret');
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
