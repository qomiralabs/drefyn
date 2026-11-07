import type { TenantRef } from '@drefyn/tenancy';
import { Refusal } from './errors.ts';

interface Lane {
  running: number;
  // A set keeps arrival order and lets a waiter that gave up leave from the middle.
  readonly waiting: Set<() => void>;
}

export interface TreeGateLimits {
  readonly slots: number;
  readonly queued: number;
  readonly waitMs: number;
}

export interface TreeGate {
  through<T>(tenant: TenantRef, work: () => Promise<T>): Promise<T>;
  // Projects with work in the gate.
  open(): number;
}

// The tree lock lets one writer through, and each waiter on it sits on a pooled connection, so a
// busy project could fill the pool however short the lock wait. The queue lives here instead,
// where waiting costs no connection and other tenants never stand behind it. One process, one
// pool, so per process is the right scope; between processes the lock wait is the bound.
export function createTreeGate({ slots, queued, waitMs }: TreeGateLimits): TreeGate {
  const lanes = new Map<string, Lane>();

  const wait = (lane: Lane) =>
    new Promise<void>((admit, refuse) => {
      const enter = () => {
        clearTimeout(timer);
        admit();
      };
      const timer = setTimeout(() => {
        lane.waiting.delete(enter);
        refuse(new Refusal('engine.unavailable'));
      }, waitMs);
      lane.waiting.add(enter);
    });

  const leave = (key: string, lane: Lane) => {
    const [next] = lane.waiting;
    if (next !== undefined) {
      // The slot passes straight on, so nothing can slip in ahead of the queue.
      lane.waiting.delete(next);
      next();
      return;
    }
    lane.running -= 1;
    if (lane.running === 0) lanes.delete(key);
  };

  return {
    async through(tenant, work) {
      const key = `${tenant.organizationId}:${tenant.projectId}`;
      const lane = lanes.get(key) ?? { running: 0, waiting: new Set() };
      lanes.set(key, lane);
      if (lane.running < slots) lane.running += 1;
      else if (lane.waiting.size >= queued) throw new Refusal('engine.unavailable');
      else await wait(lane);
      try {
        return await work();
      } finally {
        leave(key, lane);
      }
    },
    open: () => lanes.size,
  };
}
