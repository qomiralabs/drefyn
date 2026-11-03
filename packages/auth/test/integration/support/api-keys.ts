import { randomBytes } from 'node:crypto';
import { newId, withOrganization } from '@drefyn/db';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import type { AccessContext, CookieSpec, CreateApiKeyInput } from '../../../src/index.ts';
import type { Harness } from './harness.ts';

export const browser = (ip = '203.0.113.9') => ({
  ip,
  userAgent: 'Integration/1.0',
  cookies: new Map<string, string>(),
});

const cookieOf = (h: Harness, cookies: readonly CookieSpec[]) => {
  const found = cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0);
  if (found === undefined) throw new Error('no session cookie');
  return found.value;
};

export const slug = (prefix = 'org') => `${prefix}-${randomBytes(5).toString('hex')}`;

export async function signIn(h: Harness, email?: string) {
  const sessions = h.sessions();
  const user = await h.user(email);
  const started = await sessions.startSession(browser(), { userId: user, method: 'email' });
  return { sessions, user, session: started.session, cookie: cookieOf(h, started.setCookies) };
}

export interface Org {
  readonly organizationId: OrganizationId;
  readonly slug: string;
  readonly owner: AccessContext;
  readonly ownerEmail: string;
  readonly ownerSessionId: string;
}

// A fresh person who owns a fresh organization, signed in just now, so step up passes.
export async function newOrg(h: Harness): Promise<Org> {
  const ownerEmail = `o${randomBytes(4).toString('hex')}@example.com`;
  const { session } = await signIn(h, ownerEmail);
  const s = slug();
  const made = await h.organizations().createOrganization(session, { name: 'Acme', slug: s });
  if (!made.ok) throw made.error;
  return {
    organizationId: made.value.organizationId,
    slug: s,
    owner: made.value,
    ownerEmail,
    ownerSessionId: session.sessionId,
  };
}

export async function addProjects(
  h: Harness,
  org: OrganizationId,
  count: number,
): Promise<ProjectId[]> {
  const ids = Array.from({ length: count }, () => newId('prj'));
  if (count === 0) return ids;
  await withOrganization(h.db, { organizationId: org }, (tx) =>
    tx
      .insertInto('projects')
      .values(
        ids.map((id) => ({
          id,
          organization_id: org,
          product: 'docs',
          slug: slug('p'),
          name: 'Handbook',
        })),
      )
      .execute(),
  );
  return ids;
}

export async function deleteProject(h: Harness, org: OrganizationId, id: ProjectId) {
  await withOrganization(h.db, { organizationId: org }, (tx) =>
    tx.deleteFrom('projects').where('id', '=', id).execute(),
  );
}

// Another person in the organization with the given role, reached the way the guard does.
export async function memberOf(
  h: Harness,
  org: Org,
  role: 'admin' | 'member',
  defaultProjectRole: 'editor' | 'viewer' | null = 'editor',
) {
  const { session, cookie, sessions } = await signIn(h);
  const role_ = defaultProjectRole === null ? 'null' : `'${defaultProjectRole}'`;
  await h.sql(
    `insert into app.memberships (organization_id, user_id, role, default_project_role)
     values ('${org.organizationId}', '${session.userId}', '${role}', ${role_});`,
  );
  const resolved = await sessions.resolveAccess(cookie, org.slug);
  if (resolved.kind !== 'ok') throw new Error(`member did not resolve: ${resolved.kind}`);
  return { access: resolved.access, session };
}

let counter = 0;

export function input(over: Partial<CreateApiKeyInput> = {}): CreateApiKeyInput {
  counter += 1;
  return {
    name: 'Deploy from CI',
    scopes: ['docs:read'],
    projectScope: 'all',
    idempotencyKey: `it-${String(counter)}-${randomBytes(4).toString('hex')}`,
    ...over,
  };
}

// A distinct documentation address per test, so failure windows never meet.
export const testIp = () =>
  `198.51.${String(randomBytes(1)[0] ?? 0)}.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}`;
