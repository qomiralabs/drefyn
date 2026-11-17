import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileDeliveryId,
  reconcileOnce,
  startReconcile,
  type DeliveryInput,
  type GitBinding,
  type GitSyncStore,
  type ReconcileDeps,
} from '../src/index.ts';

const tenantN = (n: number): TenantRef => ({
  organizationId: organizationId(`01900000-0000-7000-8000-${String(n).padStart(12, '0')}`),
  projectId: projectId(`01900000-0000-7000-8001-${String(n).padStart(12, '0')}`),
});

const bindingFor = (tenant: TenantRef, state: GitBinding['state']): GitBinding => ({
  id: `01900000-0000-7000-8002-${tenant.projectId.slice(-12)}`,
  tenant,
  installationId: 1,
  repository: { owner: 'acme', name: 'docs', id: 2 },
  branch: 'main',
  folder: 'docs',
  lastSyncedCommit: null,
  state,
  stateCode: null,
});

async function* listed(tenants: readonly TenantRef[]): AsyncIterable<TenantRef> {
  for (const tenant of tenants) {
    await Promise.resolve();
    yield tenant;
  }
}

// An in memory store with the delivery key the table has.
function fakeStore(states: ReadonlyMap<string, GitBinding['state'] | 'throws'>) {
  const stored = new Set<string>();
  const enqueued: DeliveryInput[] = [];
  const store: Pick<GitSyncStore, 'getBinding' | 'enqueueDelivery'> = {
    getBinding: (tenant) => {
      const state = states.get(tenant.projectId);
      if (state === 'throws') return Promise.reject(new Error('connection reset'));
      return Promise.resolve({
        ok: true,
        value: state === undefined ? null : bindingFor(tenant, state),
      });
    },
    enqueueDelivery: (tenant, input) => {
      const key = `${tenant.projectId}/${input.deliveryId}`;
      if (stored.has(key)) return Promise.resolve({ ok: true, value: { stored: false } });
      stored.add(key);
      enqueued.push(input);
      return Promise.resolve({ ok: true, value: { stored: true } });
    },
  };
  return { store, enqueued };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reconcileDeliveryId', () => {
  it('names the binding and the hour, in the delivery id alphabet', () => {
    const id = reconcileDeliveryId(
      '01900000-0000-7000-8000-000000000001',
      new Date('2026-11-16T10:59:59.999Z'),
    );
    expect(id).toBe('reconcile:01900000-0000-7000-8000-000000000001:2026-11-16T10');
    expect(id).toMatch(/^[A-Za-z0-9:._-]{1,128}$/);
  });
});

describe('reconcileOnce', () => {
  const at = () => new Date('2026-11-16T10:00:00Z');

  it('queues active bindings, skips the rest and keeps going past a failure', async () => {
    const tenants = [1, 2, 3, 4, 5].map(tenantN);
    const states = new Map<string, GitBinding['state'] | 'throws'>([
      [tenants[0]?.projectId ?? '', 'active'],
      [tenants[1]?.projectId ?? '', 'paused'],
      [tenants[2]?.projectId ?? '', 'error'],
      [tenants[3]?.projectId ?? '', 'throws'],
      [tenants[4]?.projectId ?? '', 'active'],
    ]);
    const { store, enqueued } = fakeStore(states);
    const warn = vi.fn();
    const info = vi.fn();
    const deps: ReconcileDeps = {
      store,
      tenants: () => listed(tenants),
      clock: at,
      logger: { info, warn },
    };
    expect(await reconcileOnce(deps)).toEqual({
      enqueued: 2,
      duplicate: 0,
      skipped: 2,
      failed: 1,
      truncated: false,
    });
    expect(enqueued.every((input) => input.headSha === null)).toBe(true);
    expect(warn).toHaveBeenCalledWith('git_sync.reconcile_failed', {
      organization_id: tenants[3]?.organizationId,
      project_id: tenants[3]?.projectId,
    });
    expect(info).toHaveBeenCalledWith(
      'git_sync.reconciled',
      expect.objectContaining({ enqueued: 2 }),
    );
    expect(await reconcileOnce(deps)).toMatchObject({ enqueued: 0, duplicate: 2 });
  });

  it('counts a refused enqueue as skipped', async () => {
    const tenant = tenantN(1);
    const store: Pick<GitSyncStore, 'getBinding' | 'enqueueDelivery'> = {
      getBinding: () => Promise.resolve({ ok: true, value: bindingFor(tenant, 'active') }),
      enqueueDelivery: () => Promise.resolve({ ok: false, error: 'git_sync.binding_not_found' }),
    };
    expect(await reconcileOnce({ store, tenants: () => listed([tenant]) })).toMatchObject({
      skipped: 1,
    });
  });

  it('stops at its tenant cap and says so', async () => {
    const tenants = [1, 2, 3].map(tenantN);
    const { store, enqueued } = fakeStore(
      new Map(tenants.map((t) => [t.projectId, 'active' as const])),
    );
    const report = await reconcileOnce({
      store,
      tenants: () => listed(tenants),
      clock: at,
      maxTenants: 2,
    });
    expect(report).toMatchObject({ enqueued: 2, truncated: true });
    expect(enqueued).toHaveLength(2);
  });
});

describe('startReconcile', () => {
  it('runs at start and then once per interval until stopped', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const tenants = () => {
      runs += 1;
      return listed([]);
    };
    const { store } = fakeStore(new Map());
    const schedule = startReconcile({ store, tenants, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(runs).toBe(4);
    await schedule.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(4);
  });

  it('keeps its schedule after a run that throws', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const warn = vi.fn();
    const tenants = (): AsyncIterable<TenantRef> => {
      runs += 1;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('listing down')) }),
      };
    };
    const { store } = fakeStore(new Map());
    const schedule = startReconcile({
      store,
      tenants,
      intervalMs: 1000,
      logger: { info: vi.fn(), warn },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    expect(warn).toHaveBeenCalledWith('git_sync.reconcile_run_failed', {});
    await schedule.stop();
  });

  it('can stop before its first timer is set', async () => {
    const { store } = fakeStore(new Map());
    const schedule = startReconcile({ store, tenants: () => listed([]) });
    await schedule.stop();
  });
});
