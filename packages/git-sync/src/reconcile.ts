import type { TenantRef } from '@drefyn/tenancy';
import type { GitSyncStore } from './store.ts';
import { noopLogger, tenantFields, type GitSyncLogger } from './types.ts';

export const RECONCILE_INTERVAL_MS = 3_600_000;
// Projects one run visits. A host with more runs several processes over disjoint lists.
export const DEFAULT_RECONCILE_MAX_TENANTS = 10_000;

export interface ReconcileDeps {
  readonly store: Pick<GitSyncStore, 'getBinding' | 'enqueueDelivery'>;
  // Projects that may hold a binding. Row level security keeps one tenant per transaction, so
  // the host that knows its installations lists them.
  readonly tenants: () => AsyncIterable<TenantRef>;
  readonly clock?: () => Date;
  readonly logger?: GitSyncLogger;
  readonly maxTenants?: number;
}

export interface ReconcileReport {
  readonly enqueued: number;
  // Already queued by another server, or by an earlier run, this hour.
  readonly duplicate: number;
  // No binding, a paused or failed one, or git sync off or not on the plan.
  readonly skipped: number;
  readonly failed: number;
  readonly truncated: boolean;
}

// One id per binding per hour, so every server may run the reconcile and the delivery key
// still stores it once.
export function reconcileDeliveryId(bindingId: string, at: Date): string {
  return `reconcile:${bindingId}:${at.toISOString().slice(0, 13)}`;
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger ?? noopLogger;
  const max = deps.maxTenants ?? DEFAULT_RECONCILE_MAX_TENANTS;
  const report = { enqueued: 0, duplicate: 0, skipped: 0, failed: 0, truncated: false };
  let seen = 0;
  for await (const tenant of deps.tenants()) {
    if (seen === max) {
      report.truncated = true;
      break;
    }
    seen += 1;
    try {
      const binding = await deps.store.getBinding(tenant);
      if (!binding.ok || binding.value?.state !== 'active') {
        report.skipped += 1;
        continue;
      }
      const queued = await deps.store.enqueueDelivery(tenant, {
        bindingId: binding.value.id,
        deliveryId: reconcileDeliveryId(binding.value.id, clock()),
        headSha: null,
      });
      if (!queued.ok) report.skipped += 1;
      else if (queued.value.stored) report.enqueued += 1;
      else report.duplicate += 1;
    } catch {
      // One project's database error must not stop the rest; the next hour tries it again.
      report.failed += 1;
      logger.warn('git_sync.reconcile_failed', tenantFields(tenant));
    }
  }
  logger.info('git_sync.reconciled', { ...report });
  return report;
}

export interface ReconcileSchedule {
  stop(): Promise<void>;
}

// Runs at start and then every interval, one run at a time. The timer is unref'd so it never
// keeps a process alive on its own.
export function startReconcile(
  deps: ReconcileDeps & { readonly intervalMs?: number },
): ReconcileSchedule {
  const intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
  const logger = deps.logger ?? noopLogger;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = reconcileOnce(deps).then(
      () => undefined,
      () => {
        logger.warn('git_sync.reconcile_run_failed', {});
      },
    );
    void running.then(() => {
      if (stopped) return;
      timer = setTimeout(tick, intervalMs);
      timer.unref();
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
