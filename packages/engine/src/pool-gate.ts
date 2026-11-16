import type { TenantRef } from '@drefyn/tenancy';
import type { EngineConfig } from './config.ts';
import { Refusal, type EngineIssue } from './errors.ts';
import { inFlightLimit } from './in-flight.ts';

// Two, so one writer holds a project's tree lock and the next is ready as it lets go.
const TREE_SLOTS = 2;
// A place costs no connection, so this only has to outlast a burst. Same as the tree lock wait,
// which is the longest a writer ahead should take to fail.
const QUEUE_WAIT_MS = 1000;
// A stalled write holds its place for seconds and a list for milliseconds, so without this a few
// stalls would refuse every list in the process. One part in this many is for lists alone.
const LIST_ONLY_PARTS = 4;
// What an unset ceiling leaves over for reads and everything else outside the gate.
const SPARE_MIN = 2;
const SPARE_PARTS = 5;

export type GateBusy = 'organization' | 'process';
export type GatePath = 'query' | 'write';

// Who the load is. A tenant with nothing running cannot be bursting, so a refusal then is ours:
// routes answer it as an outage, and its log line is the capacity alert.
export function busyIssue(by: GateBusy, path: GatePath): EngineIssue {
  if (by === 'process') return { path, code: 'engine.pool_busy' };
  return { path, code: path === 'query' ? 'engine.query_busy' : 'engine.write_busy' };
}

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
  // A place now, or who the load is. Lists never wait: a list is cheap to retry and stale once it
  // has.
  enterList(tenant: TenantRef): (() => void) | GateBusy;
  load(): PoolGateLoad;
  // Tenants the gate is holding anything for.
  open(): number;
}

// Ceiling or queue full. A class of its own so the engine can log it apart from a refusal the
// work raised.
export class PoolBusy extends Refusal {
  readonly issue: EngineIssue;

  constructor(by: GateBusy, path: GatePath) {
    const issue = busyIssue(by, path);
    super('engine.unavailable', [issue]);
    this.issue = issue;
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
export const writePlaces = (ceiling: number): number =>
  Math.max(1, ceiling - Math.ceil(ceiling / LIST_ONLY_PARTS));

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
  const writeCeiling = writePlaces(limits.ceiling);
  // Read at the refusal and not on arrival: a waiter's own work may have ended since.
  const busyFor = (organization: string): GateBusy =>
    running.of(organization) > 0 ? 'organization' : 'process';
  const refused = (organization: string) => new PoolBusy(busyFor(organization), 'write');
  // A set keeps arrival order and lets a waiter that gave up leave from the middle.
  const waiting = new Set<Waiter>();

  const hasRoom = ({ organization, lane }: Seat) =>
    hasShare(running, organization, writeCeiling) &&
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
        refuse(refused(seat.organization));
      }, limits.waitMs);
      waiting.add(waiter);
      queued.add(seat.organization);
    });

  const through = async <T>(seat: Seat, work: () => Promise<T>): Promise<T> => {
    if (hasRoom(seat)) sit(seat);
    else if (hasShare(queued, seat.organization, limits.queued)) await wait(seat);
    else throw refused(seat.organization);
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
      if (!hasShare(running, seat.organization, limits.ceiling)) return busyFor(seat.organization);
      const leave = lists.enter(seat.organization);
      if (leave === null) return busyFor(seat.organization);
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

// A pool of 10 gives 8, and raising the pool raises this, so a small install never has to learn
// the key. A pool of 1 gives 1, which meets the pool and is refused: there is nothing to leave over.
export const derivedCeiling = (poolMax: number): number =>
  Math.max(1, poolMax - Math.max(SPARE_MIN, Math.ceil(poolMax / SPARE_PARTS)));

export const gateLimits = (config: EngineConfig, poolMax: number): PoolGateLimits => ({
  ceiling: config.poolCeiling ?? derivedCeiling(poolMax),
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
