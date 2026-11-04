import type { AccessContext, AccessView, SessionInfo } from '@drefyn/auth';
import { idOf } from '@drefyn/tenancy';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VISITOR_FLAG_ORGANIZATION } from '../src/shell/release.ts';

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
const ORIGIN = 'https://app.drefyn.test';
const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8071');
const SESSION_ID = idOf('ses', '01890a5d-ac96-774b-bcce-b302099a8072');
const ACCESS = {
  organizationId: ORG,
  userId: USER,
  sessionId: SESSION_ID,
  permissions: ['org.read', 'docs.read'],
} as unknown as AccessContext;
const VIEW: AccessView = {
  organizationSlug: 'acme',
  organizationName: 'Acme',
  email: 'maya@acme.dev',
  displayName: 'Maya Okafor',
};
const SESSION = { sessionId: SESSION_ID, userId: USER } as unknown as SessionInfo;

class Redirect extends Error {
  readonly target: string;
  constructor(target: string) {
    super('NEXT_REDIRECT');
    this.target = target;
  }
}

const requireDashboard = vi.fn<(org: string, user: string) => Promise<void>>();
const requireDashboardForVisitor = vi.fn<() => Promise<void>>();
const resolveAccess = vi.fn();
const resolveSession = vi.fn();
const touchSession = vi.fn();
const listMyOrganizations = vi.fn();
const dashboardAuth = vi.fn();
const sessionCookieName = vi.fn(() => 'drefyn_session');
const after = vi.fn();
const connection = vi.fn(() => Promise.resolve());

let cookie: string | undefined;
let requestHeaders: Headers;

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
  redirect: (target: string) => {
    throw new Redirect(target);
  },
}));
vi.mock('next/server', () => ({ connection, after }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'drefyn_session' && cookie !== undefined ? { value: cookie } : undefined,
    }),
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock('../src/server/gate.ts', () => ({ requireDashboard, requireDashboardForVisitor }));
vi.mock('../src/server/auth.ts', () => ({ dashboardAuth, sessionCookieName }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DREFYN_APP_ORIGIN', ORIGIN);
  cookie = 'token';
  requestHeaders = new Headers({ 'x-drefyn-request-path': '/acme/docs?tab=a' });
  requireDashboard.mockResolvedValue(undefined);
  requireDashboardForVisitor.mockResolvedValue(undefined);
  resolveAccess.mockResolvedValue({ kind: 'ok', access: ACCESS, view: VIEW, touchDue: false });
  resolveSession.mockResolvedValue(SESSION);
  listMyOrganizations.mockResolvedValue([{ organizationId: ORG, slug: 'acme', name: 'Acme' }]);
  dashboardAuth.mockResolvedValue({
    sessions: { resolveAccess, resolveSession, touchSession },
    organizations: { listMyOrganizations },
  });
});

const load = async () => import('../src/server/guard.ts');

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('guardOrganization', () => {
  it('returns the access and the view, after the flag with the real ids', async () => {
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).resolves.toEqual({ access: ACCESS, view: VIEW });
    expect(resolveAccess).toHaveBeenCalledWith('token', 'acme');
    expect(requireDashboard).toHaveBeenCalledWith(ORG, USER);
    expect(requireDashboardForVisitor).not.toHaveBeenCalled();
  });

  it('marks the render as dynamic first', async () => {
    const { guardOrganization } = await load();
    await guardOrganization('acme');
    const first = connection.mock.invocationCallOrder[0] ?? Infinity;
    expect(first).toBeLessThan(dashboardAuth.mock.invocationCallOrder[0] ?? 0);
  });

  it.each(['', 'bundle-baseline', 'api', '__proto__', 'a/b', '..'])(
    'is a 404 for the slug %j with no flag and no database',
    async (slug) => {
      const { guardOrganization } = await load();
      await expect(guardOrganization(slug)).rejects.toBe(NOT_FOUND);
      expect(dashboardAuth).not.toHaveBeenCalled();
      expect(requireDashboardForVisitor).not.toHaveBeenCalled();
    },
  );

  it('with no cookie, redirects after the visitor check and touches no database', async () => {
    cookie = undefined;
    const { guardOrganization } = await load();
    const error = await caught(() => guardOrganization('acme'));
    expect(error).toBeInstanceOf(Redirect);
    expect((error as Redirect).target).toBe('/sign-in?next=%2Facme%2Fdocs%3Ftab%3Da');
    expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    expect(dashboardAuth).not.toHaveBeenCalled();
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it('answers a known and an unknown slug alike with no cookie', async () => {
    cookie = undefined;
    const { guardOrganization } = await load();
    const known = await caught(() => guardOrganization('acme'));
    const unknown = await caught(() => guardOrganization('zzz'));
    expect((unknown as Redirect).target).toBe((known as Redirect).target);
    expect(dashboardAuth).not.toHaveBeenCalled();
  });

  it('with no cookie and the flag off, is the 404 and never the redirect', async () => {
    cookie = undefined;
    requireDashboardForVisitor.mockRejectedValue(NOT_FOUND);
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).rejects.toBe(NOT_FOUND);
  });

  it('treats a dead session like no cookie, after the visitor check', async () => {
    resolveAccess.mockResolvedValue({ kind: 'signed_out' });
    const { guardOrganization } = await load();
    expect(await caught(() => guardOrganization('acme'))).toBeInstanceOf(Redirect);
    expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    expect(requireDashboard).not.toHaveBeenCalled();
  });

  it('is a 404 for a non member before any flag read', async () => {
    resolveAccess.mockResolvedValue({ kind: 'not_member' });
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).rejects.toBe(NOT_FOUND);
    expect(requireDashboard).not.toHaveBeenCalled();
    expect(requireDashboardForVisitor).not.toHaveBeenCalled();
  });

  it('is a 404 when the flag says no for this organization', async () => {
    requireDashboard.mockRejectedValue(NOT_FOUND);
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).rejects.toBe(NOT_FOUND);
  });

  it('touches the session after the response, only when due', async () => {
    const { guardOrganization } = await load();
    await guardOrganization('acme');
    expect(after).not.toHaveBeenCalled();
    resolveAccess.mockResolvedValue({ kind: 'ok', access: ACCESS, view: VIEW, touchDue: true });
    await guardOrganization('acme');
    expect(after).toHaveBeenCalledTimes(1);
    expect(touchSession).not.toHaveBeenCalled();
    (after.mock.calls[0]?.[0] as () => void)();
    expect(touchSession).toHaveBeenCalledWith({
      userId: USER,
      sessionId: SESSION_ID,
      organizationId: ORG,
    });
  });

  describe('when auth throws', () => {
    const outage = new Error('database down');

    it('with the flag on, rethrows: a 500, never a redirect or a 404', async () => {
      resolveAccess.mockRejectedValue(outage);
      const { guardOrganization } = await load();
      await expect(guardOrganization('acme')).rejects.toBe(outage);
      expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    });

    it('with the flag off, is the 404', async () => {
      resolveAccess.mockRejectedValue(outage);
      requireDashboardForVisitor.mockRejectedValue(NOT_FOUND);
      const { guardOrganization } = await load();
      await expect(guardOrganization('acme')).rejects.toBe(NOT_FOUND);
    });

    it('covers a failure to build auth too', async () => {
      dashboardAuth.mockRejectedValue(outage);
      const { guardOrganization } = await load();
      await expect(guardOrganization('acme')).rejects.toBe(outage);
      expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    });

    it('covers a config that cannot name the cookie', async () => {
      sessionCookieName.mockImplementationOnce(() => {
        throw outage;
      });
      const { guardOrganization } = await load();
      await expect(guardOrganization('acme')).rejects.toBe(outage);
      expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    });
  });

  describe('the next value', () => {
    const target = async (path: string | null) => {
      cookie = undefined;
      requestHeaders = new Headers(
        path === null || !/^[\t\x20-\x7e]*$/.test(path) ? {} : { 'x-drefyn-request-path': path },
      );
      const { guardOrganization } = await load();
      return ((await caught(() => guardOrganization('acme'))) as Redirect).target;
    };

    it.each([
      [null, '/'],
      ['//evil.test', '/'],
      ['/\\evil.test', '/'],
      ['https://evil.test/', '/'],
      ['/x/..//evil.test', '/'],
    ])('keeps %j on the origin', async (path, next) => {
      expect(await target(path)).toBe(`/sign-in?next=${encodeURIComponent(next)}`);
    });

    it('stays on the origin for any input', async () => {
      const hostile = fc.oneof(
        fc.string(),
        fc.webUrl(),
        fc.webPath(),
        fc
          .array(
            fc.constantFrom('/', '\\', '.', '..', '//', '@', ':', '%2f', 'evil.test', '?', '#'),
            {
              maxLength: 8,
            },
          )
          .map((parts) => parts.join('')),
      );
      await fc.assert(
        fc.asyncProperty(hostile, async (path) => {
          const location = new URL(await target(path), ORIGIN);
          expect(location.origin).toBe(ORIGIN);
          expect(location.pathname).toBe('/sign-in');
          const next = location.searchParams.get('next') ?? '';
          expect(next.startsWith('/')).toBe(true);
          expect(new URL(next, ORIGIN).origin).toBe(ORIGIN);
        }),
      );
    });
  });
});

describe('guardSignedIn', () => {
  it('returns the session and organizations after the flag with the first real ids', async () => {
    const other = {
      organizationId: idOf('org', '01890a5d-ac96-774b-bcce-b302099a8079'),
      slug: 'b',
    };
    const first = { organizationId: ORG, slug: 'acme', name: 'Acme' };
    listMyOrganizations.mockResolvedValue([first, other]);
    const { guardSignedIn } = await load();
    await expect(guardSignedIn()).resolves.toEqual({
      session: SESSION,
      organizations: [first, other],
    });
    expect(requireDashboard).toHaveBeenCalledWith(ORG, USER);
  });

  it('is a 404 for a person with no organization', async () => {
    listMyOrganizations.mockResolvedValue([]);
    const { guardSignedIn } = await load();
    await expect(guardSignedIn()).rejects.toBe(NOT_FOUND);
  });

  it('redirects with no cookie, after the visitor check, with no database', async () => {
    cookie = undefined;
    const { guardSignedIn } = await load();
    expect(await caught(() => guardSignedIn())).toBeInstanceOf(Redirect);
    expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    expect(dashboardAuth).not.toHaveBeenCalled();
  });

  it('redirects for a dead session', async () => {
    resolveSession.mockResolvedValue(null);
    const { guardSignedIn } = await load();
    expect(await caught(() => guardSignedIn())).toBeInstanceOf(Redirect);
  });

  it('runs the visitor check before an outage surfaces', async () => {
    const outage = new Error('database down');
    resolveSession.mockRejectedValue(outage);
    requireDashboardForVisitor.mockRejectedValue(NOT_FOUND);
    const { guardSignedIn } = await load();
    await expect(guardSignedIn()).rejects.toBe(NOT_FOUND);
  });
});

describe('guardSession', () => {
  it('needs no organization, for account level actions', async () => {
    listMyOrganizations.mockResolvedValue([]);
    const { guardSession } = await load();
    await expect(guardSession()).resolves.toBe(SESSION);
    expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    expect(listMyOrganizations).not.toHaveBeenCalled();
  });

  it('is off with the flag, signed in or not', async () => {
    requireDashboardForVisitor.mockRejectedValue(NOT_FOUND);
    const { guardSession } = await load();
    await expect(guardSession()).rejects.toBe(NOT_FOUND);
  });
});

describe('guardPublic', () => {
  it('runs the visitor check alone', async () => {
    const { guardPublic } = await load();
    await expect(guardPublic()).resolves.toBeUndefined();
    expect(requireDashboardForVisitor).toHaveBeenCalledTimes(1);
    expect(dashboardAuth).not.toHaveBeenCalled();
  });
});

describe('the reserved visitor id', () => {
  it('is the nil UUID, which no generated id can be', () => {
    expect(VISITOR_FLAG_ORGANIZATION).toBe('00000000-0000-0000-0000-000000000000');
  });
});
