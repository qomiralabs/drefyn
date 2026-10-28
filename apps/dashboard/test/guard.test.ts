import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
const requireDashboard = vi.fn<(id: string) => Promise<void>>();

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));
vi.mock('../src/server/gate.ts', () => ({ requireDashboard }));

beforeEach(() => {
  requireDashboard.mockReset();
  requireDashboard.mockResolvedValue(undefined);
});

const load = async () => import('../src/server/guard.ts');

describe('guardOrganization', () => {
  it('returns the organization once the flag allows it', async () => {
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).resolves.toMatchObject({
      slug: 'acme',
      name: 'Acme',
    });
    expect(requireDashboard).toHaveBeenCalledWith('org_acme');
  });

  it.each(['nope', 'ACME', 'Acme', '', 'bundle-baseline', '__proto__', 'constructor'])(
    'is a 404 for %j before the flag is read',
    async (slug) => {
      const { guardOrganization } = await load();
      await expect(guardOrganization(slug)).rejects.toBe(NOT_FOUND);
      expect(requireDashboard).not.toHaveBeenCalled();
    },
  );

  it('is a 404 when the flag says no', async () => {
    requireDashboard.mockRejectedValue(NOT_FOUND);
    const { guardOrganization } = await load();
    await expect(guardOrganization('acme')).rejects.toBe(NOT_FOUND);
  });
});
