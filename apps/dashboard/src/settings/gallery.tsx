import type { ReactNode } from 'react';
import { KeysScreen, type KeysFacts, type KeyRow } from './api-keys.tsx';
import { MembersScreen, type MembersFacts } from './members.tsx';
import { MethodsScreen, type MethodsFacts } from './methods.tsx';
import { seatsFrom } from './models.ts';
import { LoadingPage, LoadProblem } from './parts.tsx';
import { ProfileScreen, type ProfileFacts } from './profile.tsx';
import { SessionsScreen, type SessionRow } from './sessions.tsx';

const NOW = '2026-10-31T12:00:00.000Z';
const REFERENCE = 'ref_0a1b2c3d4e5f';

const PROFILE: ProfileFacts = {
  name: 'Maya Okafor',
  email: 'maya@acme.dev',
  confirmedAt: '2026-10-03T09:00:00.000Z',
  organizations: ['Acme', 'Northwind Labs'],
};

const METHODS: MethodsFacts = {
  email: 'maya@acme.dev',
  emailOn: true,
  passwordsOn: true,
  configured: ['github', 'google'],
  passwordSetAt: '2026-10-14T09:00:00.000Z',
  identities: [
    { provider: 'github', account: 'maya@acme.dev', linkedAt: '2026-10-03T09:00:00.000Z' },
  ],
  others: [
    { id: 's2', browser: 'Chrome on Windows' },
    { id: 's3', browser: 'Safari on iOS' },
  ],
};

const SESSIONS: readonly SessionRow[] = [
  {
    id: 's1',
    browser: 'Firefox on macOS',
    createdAt: '2026-10-28T09:00:00.000Z',
    lastSeenAt: NOW,
    current: true,
  },
  {
    id: 's2',
    browser: 'Chrome on Windows',
    createdAt: '2026-10-12T09:00:00.000Z',
    lastSeenAt: '2026-10-29T18:00:00.000Z',
    current: false,
  },
  {
    id: 's3',
    browser: 'Safari on iOS',
    createdAt: '2026-10-03T09:00:00.000Z',
    lastSeenAt: '2026-10-30T18:00:00.000Z',
    current: false,
  },
];

const MEMBERS: MembersFacts = {
  org: 'acme',
  organization: 'Acme',
  actorRole: 'owner',
  manage: true,
  members: [
    {
      id: 'm1',
      name: 'Maya Okafor',
      email: 'maya@acme.dev',
      role: 'owner',
      defaultProjectRole: null,
      joinedAt: '2026-10-03T09:00:00.000Z',
      self: true,
      projectRoles: [],
    },
    {
      id: 'm2',
      name: 'Priya Shah',
      email: 'priya@acme.dev',
      role: 'admin',
      defaultProjectRole: null,
      joinedAt: '2026-10-04T09:00:00.000Z',
      self: false,
      projectRoles: [],
    },
    {
      id: 'm3',
      name: 'Sam Rivera',
      email: 'sam@acme.dev',
      role: 'member',
      defaultProjectRole: 'editor',
      joinedAt: '2026-10-09T09:00:00.000Z',
      self: false,
      projectRoles: [{ projectId: 'p1', role: 'admin' }],
    },
    {
      id: 'm4',
      name: 'Lee Park',
      email: 'lee@acme.dev',
      role: 'member',
      defaultProjectRole: 'viewer',
      joinedAt: '2026-10-20T09:00:00.000Z',
      self: false,
      projectRoles: [],
    },
  ],
  invitations: [
    {
      id: 'i1',
      email: 'jordan@acme.dev',
      role: 'member',
      defaultProjectRole: 'editor',
      invitedBy: 'Priya Shah',
      expiresAt: '2026-11-06T14:20:00.000Z',
      expired: false,
    },
  ],
  projects: [
    { id: 'p1', name: 'Payments API docs', product: 'docs' },
    { id: 'p2', name: 'status.acme.com', product: 'status' },
  ],
  seats: seatsFrom({ used: 5, limit: 10 }),
  now: NOW,
};

const KEY: KeyRow = {
  id: 'k1',
  name: 'ci-deploy',
  suffix: 'k3f9',
  scopes: ['docs:pages.read', 'docs:pages.publish'],
  projectScope: 'listed',
  projectIds: ['p1'],
  state: 'live',
  creatorName: 'Sam Rivera',
  createdAt: '2026-10-12T09:00:00.000Z',
  lastUsedAt: '2026-10-31T09:12:00.000Z',
  expiresAt: '2027-01-10T09:00:00.000Z',
};

const KEYS: KeysFacts = {
  org: 'acme',
  organization: 'Acme',
  manage: true,
  apiOrigin: 'https://api.drefyn.com',
  now: NOW,
  keys: [
    KEY,
    {
      ...KEY,
      id: 'k2',
      name: 'status-bot',
      suffix: 'a1b2',
      scopes: ['status:incidents.write'],
      projectScope: 'all',
      projectIds: [],
      creatorName: 'Priya Shah',
      lastUsedAt: null,
    },
    {
      ...KEY,
      id: 'k3',
      name: 'old-sync',
      suffix: '77xq',
      scopes: ['docs:pages.read'],
      state: 'revoked',
      creatorName: null,
      lastUsedAt: '2026-10-20T09:00:00.000Z',
      expiresAt: null,
    },
  ],
  matched: 3,
  total: 3,
  live: 2,
  nextCursor: null,
  creators: [
    { membershipId: 'm3', name: 'Sam Rivera', keys: 1 },
    { membershipId: 'm2', name: 'Priya Shah', keys: 1 },
  ],
  formerKeys: 1,
  products: { docs: 2, studio: 0, status: 1 },
  filters: { products: [], createdBy: [], lastUsed: 'any' },
  projectNames: { p1: 'Payments API docs' },
  projects: [{ id: 'p1', name: 'Payments API docs' }],
  grantable: [
    'docs:pages.read',
    'docs:pages.publish',
    'status:status.read',
    'status:incidents.write',
  ],
};

const EMPTY_KEYS: KeysFacts = {
  ...KEYS,
  keys: [],
  matched: 0,
  total: 0,
  live: 0,
  creators: [],
  formerKeys: 0,
};

const SHOWN = {
  name: 'netlify-build',
  secret: 'drf_ak_gallery_not_a_real_key',
  scopes: ['docs:pages.read', 'docs:pages.publish'],
  projectScope: 'listed',
  projectIds: ['p1'],
  expiresAt: '2027-01-29T09:00:00.000Z',
} as const;

const problem = (title: string, words: string) => (
  <LoadProblem title={title} reference={REFERENCE}>
    {words}
  </LoadProblem>
);

// Every state of every settings page, from fixed words, so visual and axe checks reach the
// failures and limits a healthy stack never shows.
export const SETTINGS_STATES: Readonly<Record<string, Readonly<Record<string, () => ReactNode>>>> =
  {
    profile: {
      ready: () => <ProfileScreen facts={PROFILE} />,
      loading: () => <LoadingPage name="Profile and email, loading" width="calm" rows={1} />,
      error: () =>
        problem(
          'Could not load your profile',
          'Your account is fine and you are still signed in. Only this page did not load.',
        ),
      change: () => <ProfileScreen facts={PROFILE} open="address" />,
      code: () => <ProfileScreen facts={PROFILE} open="code" openAddress="maya.okafor@acme.dev" />,
      changed: () => <ProfileScreen facts={PROFILE} changedTo="maya.okafor@acme.dev" />,
    },
    methods: {
      ready: () => <MethodsScreen facts={METHODS} />,
      loading: () => <LoadingPage name="Sign in methods, loading" width="calm" rows={4} />,
      error: () =>
        problem(
          'Could not load your sign in methods',
          'Nothing changed, and every way you sign in still works. Only this page did not load.',
        ),
      'only-one': () => (
        <MethodsScreen facts={{ ...METHODS, emailOn: false, passwordSetAt: null }} />
      ),
      remove: () => <MethodsScreen facts={METHODS} open="remove" />,
      removed: () => (
        <MethodsScreen facts={{ ...METHODS, passwordSetAt: null }} removed="Password" />
      ),
      password: () => <MethodsScreen facts={METHODS} open="password" />,
      'add-open': () => <MethodsScreen facts={METHODS} addOpen />,
      failed: () => <MethodsScreen facts={METHODS} providerFailed />,
    },
    sessions: {
      ready: () => <SessionsScreen sessions={SESSIONS} now={NOW} />,
      loading: () => <LoadingPage name="Sessions, loading" width="work" rows={3} />,
      error: () =>
        problem(
          'Could not load your sessions',
          'Nobody was signed out. Try again; if you think someone else is signed in, reset your password from the sign in page, which signs out everyone else.',
        ),
      single: () => <SessionsScreen sessions={SESSIONS.slice(0, 1)} now={NOW} />,
      everywhere: () => <SessionsScreen sessions={SESSIONS} now={NOW} everywhere />,
    },
    members: {
      ready: () => <MembersScreen facts={MEMBERS} />,
      loading: () => <LoadingPage name="Members, loading" width="work" rows={4} />,
      error: () =>
        problem(
          'Could not load the members of Acme',
          'Everyone keeps their access. Only this page did not load.',
        ),
      member: () => (
        <MembersScreen
          facts={{ ...MEMBERS, manage: false, actorRole: 'member', invitations: [] }}
        />
      ),
      full: () => (
        <MembersScreen facts={{ ...MEMBERS, seats: seatsFrom({ used: 10, limit: 10 }) }} />
      ),
      over: () => (
        <MembersScreen
          facts={{ ...MEMBERS, invitations: [], seats: seatsFrom({ used: 12, limit: 10 }) }}
        />
      ),
      filtered: () => (
        <MembersScreen
          facts={MEMBERS}
          initialFilter={{
            search: 'zed',
            roles: [],
            statuses: ['active', 'invited'],
            sort: 'name',
          }}
        />
      ),
      invite: () => <MembersScreen facts={MEMBERS} overlay={{ kind: 'invite' }} />,
      access: () => <MembersScreen facts={MEMBERS} overlay={{ kind: 'access', member: 'm3' }} />,
      remove: () => (
        <MembersScreen
          facts={MEMBERS}
          overlay={{
            kind: 'remove',
            member: 'm3',
            more: false,
            keys: [
              { keyId: 'k1', name: 'ci-deploy', suffix: 'k3f9', lastUsedAt: NOW },
              { keyId: 'k2', name: 'docs-sync', suffix: '77xq', lastUsedAt: null },
            ],
          }}
        />
      ),
    },
    keys: {
      ready: () => <KeysScreen facts={KEYS} />,
      loading: () => <LoadingPage name="API keys, loading" width="work" rows={3} />,
      error: () =>
        problem(
          'Could not load API keys',
          'Every key still works as before. Only this page did not load.',
        ),
      empty: () => <KeysScreen facts={EMPTY_KEYS} />,
      member: () => <KeysScreen facts={{ ...KEYS, manage: false }} />,
      filtered: () => (
        <KeysScreen
          facts={{ ...KEYS, keys: [], matched: 0, filters: { ...KEYS.filters, search: 'zed' } }}
        />
      ),
      create: () => <KeysScreen facts={KEYS} overlay="create" />,
      shown: () => <KeysScreen facts={KEYS} shownKey={SHOWN} />,
      revoke: () => <KeysScreen facts={KEYS} overlay={{ revoke: 'k1' }} />,
    },
  };
