import type { TenantRef } from '@drefyn/tenancy';
import type { EngineConfig } from './config.ts';
import { Refusal } from './errors.ts';
import { inFlightLimit } from './in-flight.ts';

// Two, so one writer holds a project's tree lock and the next is ready as it lets go.
const TREE_SLOTS = 2;
// A place costs no connection, so this only has to outlast a burst. Same as the tree lock wait,
// which is the longest a writer ahead should take to fail.
const QUEUE_WAIT_MS = 1000;

export interface PoolGateLimits {
  readonly ceiling: number;
  readonly queued: number;
  readonly waitMs: number;
  readonly treeSlots: number;
  readonly listsPerOrganization: number;
}

export interface PoolGateLoad {
  readonly running: number;
  readonly waiting: number;
}

export interface PoolGate {
  // Runs now, or waits off the pool for a place, and refuses with PoolBusy when it cannot.
  write<T>(tenant: TenantRef, work: () => Promise<T>): Promise<T>;
  // The same, within the slots of one project.
  treeWrite<T>(tenant: TenantRef, work: () => Promise<T>): Promise<T>;
  // A place now or null. Lists never wait: a list is cheap to retry and stale once it has.
  enterList(tenant: TenantRef): (() => void) | null;
  load(): PoolGateLoad;
  // Tenants the gate is holding anything for.
  open(): number;
}

// Ceiling or queue full. A class of its own so the engine can log it apart from a refusal the
// work raised.
export class PoolBusy extends Refusal {
  constructor() {
    super('engine.unavailable');
  }
}

interface Tally {
  of(key: string): number;
  total(): number;
  keys(): number;
  add(key: string): void;
  remove(key: string): void;
}

// A key at zero is dropped, so the table is only as big as the work.
function tally(): Tally {
  const counts = new Map<string, number>();
  let total = 0;
  return {
    of: (key) => counts.get(key) ?? 0,
    total: () => total,
    keys: () => counts.size,
    add(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    },
    remove(key) {
      const left = (counts.get(key) ?? 1) - 1;
      if (left === 0) counts.delete(key);
      else counts.set(key, left);
      total -= 1;
    },
  };
}

// A tenant may take one more only while it holds less than what is still free. Alone that is half
// the capacity, a few tenants share what they leave, and whoever has nothing gets in while
// anything is free, so room for a newcomer needs no fixed share and an idle gate wastes none.
const hasShare = (counted: Tally, key: string, capacity: number) =>
  counted.of(key) < capacity - counted.total();

interface Seat {
  readonly organization: string;
  // Null for work that holds no project's tree lock.
  readonly lane: string | null;
}

interface Waiter {
  readonly seat: Seat;
  readonly enter: () => void;
}

// A busy tenant must not take connections from the rest of the process. Holds what reaches the
// pool below its size, for all tenants together, with the wait for a place off the pool, where it
// costs no connection. One process, one pool, so this is per process; the key is the organization
// because a project in it would multiply the share by projects. Between processes each pool has
// its own gate.
export function createPoolGate(limits: PoolGateLimits): PoolGate {
  const running = tally();
  const queued = tally();
  const lanes = tally();
  const lists = inFlightLimit(limits.listsPerOrganization);
  // A set keeps arrival order and lets a waiter that gave up leave from the middle.
  const waiting = new Set<Waiter>();

  const hasRoom = ({ organization, lane }: Seat) =>
    hasShare(running, organization, limits.ceiling) &&
    (lane === null || lanes.of(lane) < limits.treeSlots);

  const sit = ({ organization, lane }: Seat) => {
    running.add(organization);
    if (lane !== null) lanes.add(lane);
  };

  const unqueue = (waiter: Waiter) => {
    waiting.delete(waiter);
    queued.remove(waiter.seat.organization);
  };

  // After this nobody waiting has room, and room depends only on the organization and the lane,
  // so an arrival that finds room cannot be passing anyone of its own.
  const seatWaiters = () => {
    for (const waiter of waiting) {
      if (!hasRoom(waiter.seat)) continue;
      unqueue(waiter);
      sit(waiter.seat);
      waiter.enter();
    }
  };

  const stand = ({ organization, lane }: Seat) => {
    running.remove(organization);
    if (lane !== null) lanes.remove(lane);
    seatWaiters();
  };

  const wait = (seat: Seat) =>
    new Promise<void>((admit, refuse) => {
      const waiter: Waiter = {
        seat,
        enter: () => {
          clearTimeout(timer);
          admit();
        },
      };
      const timer = setTimeout(() => {
        unqueue(waiter);
        refuse(new PoolBusy());
      }, limits.waitMs);
      waiting.add(waiter);
      queued.add(seat.organization);
    });

  const through = async <T>(seat: Seat, work: () => Promise<T>): Promise<T> => {
    if (hasRoom(seat)) sit(seat);
    else if (hasShare(queued, seat.organization, limits.queued)) await wait(seat);
    else throw new PoolBusy();
    try {
      return await work();
    } finally {
      stand(seat);
    }
  };

  return {
    write: (tenant, work) => through({ organization: tenant.organizationId, lane: null }, work),
    treeWrite: (tenant, work) =>
      through(
        {
          organization: tenant.organizationId,
          lane: `${tenant.organizationId}:${tenant.projectId}`,
        },
        work,
      ),
    enterList(tenant) {
      const seat = { organization: tenant.organizationId, lane: null };
      if (!hasRoom(seat)) return null;
      const leave = lists.enter(seat.organization);
      if (leave === null) return null;
      sit(seat);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        leave();
        stand(seat);
      };
    },
    load: () => ({ running: running.total(), waiting: queued.total() }),
    open: () => running.keys() + queued.keys() + lanes.keys() + lists.keys(),
  };
}

export const gateLimits = (config: EngineConfig): PoolGateLimits => ({
  ceiling: config.poolCeiling,
  queued: config.poolQueue,
  waitMs: QUEUE_WAIT_MS,
  treeSlots: TREE_SLOTS,
  listsPerOrganization: config.queryMaxInFlight,
});

// The ceiling is what keeps a connection free for everything it does not cover, so one at or above
// the pool protects nothing and must not start.
export function assertCeilingBelowPool(ceiling: number, poolMax: number): void {
  if (ceiling >= poolMax) {
    throw new Error(
      `DREFYN_ENGINE_POOL_CEILING (${String(ceiling)}) must stay below DREFYN_DATABASE_POOL_MAX (${String(poolMax)})`,
    );
  }
}

interface PoolEntry {
  readonly limits: PoolGateLimits;
  readonly gate: PoolGate;
}

const GATES = new WeakMap<object, PoolEntry>();

const sameLimits = (a: PoolGateLimits, b: PoolGateLimits) =>
  a.ceiling === b.ceiling &&
  a.queued === b.queued &&
  a.waitMs === b.waitMs &&
  a.treeSlots === b.treeSlots &&
  a.listsPerOrganization === b.listsPerOrganization;

// A gate per engine would be silent: each would count alone and the ceiling would multiply. So the
// pool owns it, however many engines and stores an app builds over that pool.
export function gateFor(pool: object, limits: PoolGateLimits, poolMax: number): PoolGate {
  assertCeilingBelowPool(limits.ceiling, poolMax);
  const known = GATES.get(pool);
  if (known !== undefined) {
    if (!sameLimits(known.limits, limits)) {
      throw new Error('one pool has one gate: every engine over it needs the same limits');
    }
    return known.gate;
  }
  const gate = createPoolGate(limits);
  GATES.set(pool, { limits, gate });
  return gate;
}
