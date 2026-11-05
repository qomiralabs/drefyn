import type { AccessContext, Permission } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listReachableProjects = vi.fn();
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ members: { listReachableProjects } }),
}));

const { findProject, projectsInReach, projectsOf, reachesProduct } =
  await import('../src/server/projects.ts');

const access = (...permissions: Permission[]) =>
  ({ organizationId: 'org', permissions }) as unknown as AccessContext;
const project = (slug: string, product: string) => ({
  projectId: `id-${slug}`,
  slug,
  name: slug,
  product,
  readOnly: false,
});
const held = (...rows: object[]) => {
  listReachableProjects.mockResolvedValue({ ok: true, value: rows });
};

beforeEach(() => {
  listReachableProjects.mockReset();
});

describe('projects in reach', () => {
  it('passes the access context down, so the read is the auth layer deciding', async () => {
    const who = access('docs.read');
    held(project('a', 'docs'));
    expect(await projectsInReach(who)).toHaveLength(1);
    expect(listReachableProjects).toHaveBeenCalledWith(who);
  });

  it('throws what the read refused, for the error boundary', async () => {
    const error = new Error('down');
    listReachableProjects.mockResolvedValue({ ok: false, error });
    await expect(projectsInReach(access())).rejects.toBe(error);
  });

  it('lists one product and finds a project only under its own product', async () => {
    const who = access('docs.read', 'status.read');
    held(project('a', 'docs'), project('a', 'status'), project('b', 'docs'));
    expect((await projectsOf(who, 'docs')).map((p) => p.slug)).toEqual(['a', 'b']);
    expect((await findProject(who, 'status', 'a'))?.projectId).toBe('id-a');
    expect(await findProject(who, 'status', 'b')).toBeUndefined();
    expect(await findProject(who, 'blog', 'a')).toBeUndefined();
  });
});

describe('product reach', () => {
  it('comes from the permission', () => {
    expect(reachesProduct(access('docs.read'), [], 'docs')).toBe(true);
    expect(reachesProduct(access('status.read'), [], 'docs')).toBe(false);
  });

  it('comes from one granted project when the permission is missing', () => {
    const projects = [{ product: 'docs' as const }];
    expect(reachesProduct(access(), projects, 'docs')).toBe(true);
    expect(reachesProduct(access(), projects, 'status')).toBe(false);
  });
});
