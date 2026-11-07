import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Refusal } from '../src/errors.ts';
import {
  assertCeilingBelowPool,
  createPoolGate,
  gateFor,
  PoolBusy,
  type PoolGate,
  type PoolGateLimits,
} from '../src/pool-gate.ts';

const inOrganization = (organization: number, project: number): TenantRef => ({
  organizationId: organizationId(`01890a5d-ac96-774b-bcce-b302099a${String(1000 + organization)}`),
  projectId: projectId(`01890a5d-ac96-774b-bcce-b302099a${String(9000 + project)}`),
});
const tenant = (project: number): TenantRef => inOrganization(1, project);
const HOME = tenant(1);
const OTHER = tenant(2);

const unavailable = { error: { code: 'engine.unavailable', retryable: true, issues: [] } };

// Work that runs until the test says so.
const held = () => {
  let finish: () => void = () => undefined;
  let started = false;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = () => {
    started = true;
    return done;
  };
  return { work, finish, started: () => started };
};

const flush = () => vi.advanceTimersByTimeAsync(0);

// Room enough that only the per project lane is in play.
const WIDE: PoolGateLimits = {
  ceiling: 100,
  queued: 4,
  waitMs: 1000,
  treeSlots: 2,
  listsPerOrganization: 4,
};

describe('tree writes in a project', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const gate = (): PoolGate => createPoolGate(WIDE);

  it('runs up to its slots at once and queues the rest in order', async () => {
    const pass = gate();
    const [a, b, c, d] = [held(), held(), held(), held()];
    const all = [a, b, c, d].map(({ work }) => pass.treeWrite(HOME, work));
    await flush();
    expect([a.started(), b.started(), c.started(), d.started()]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    a.finish();
    await flush();
    expect([c.started(), d.started()]).toEqual([true, false]);
    b.finish();
    c.finish();
    await flush();
    d.finish();
    await Promise.all(all);
  });

  it('refuses at once when the queue is full, and the work never runs', async () => {
    const pass = gate();
    const first = [held(), held(), held(), held()];
    const all = first.map(({ work }) => pass.treeWrite(HOME, work));
    const late = held();
    await expect(pass.treeWrite(HOME, late.work)).rejects.toMatchObject(unavailable);
    expect(late.started()).toBe(false);
    for (const { finish } of first) finish();
    await flush();
    await Promise.all(all);
  });

  it('gives up on a wait, and the place is free again', async () => {
    const pass = gate();
    const [a, b, c] = [held(), held(), held()];
    const running = [pass.treeWrite(HOME, a.work), pass.treeWrite(HOME, b.work)];
    const waiting = pass.treeWrite(HOME, c.work);
    const outcome = expect(waiting).rejects.toBeInstanceOf(Refusal);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(c.started()).toBe(false);

    const d = held();
    const next = pass.treeWrite(HOME, d.work);
    a.finish();
    await flush();
    expect(d.started()).toBe(true);
    b.finish();
    d.finish();
    await Promise.all([...running, next]);
  });

  it('keeps one project out of the way of another', async () => {
    const pass = gate();
    const [a, b, c] = [held(), held(), held()];
    const busy = [pass.treeWrite(HOME, a.work), pass.treeWrite(HOME, b.work)];
    const free = pass.treeWrite(OTHER, c.work);
    await flush();
    expect(c.started()).toBe(true);
    a.finish();
    b.finish();
    c.finish();
    await Promise.all([...busy, free]);
  });

  it('frees a slot when the work throws, and passes the throw on', async () => {
    const pass = gate();
    const boom = new Error('boom');
    await expect(pass.treeWrite(HOME, () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(pass.treeWrite(HOME, () => Promise.resolve(7))).resolves.toBe(7);
    expect(pass.open()).toBe(0);
  });

  it('forgets a project once it is quiet, so the map cannot grow with tenants', async () => {
    const pass = gate();
    const a = held();
    const running = pass.treeWrite(HOME, a.work);
    expect(pass.open()).toBeGreaterThan(0);
    a.finish();
    await running;
    expect(pass.open()).toBe(0);
  });

  it('forgets a project whose last waiter gave up before the work ended', async () => {
    const pass = createPoolGate({ ...WIDE, treeSlots: 1, queued: 2 });
    const a = held();
    const running = pass.treeWrite(HOME, a.work);
    const waiting = expect(pass.treeWrite(HOME, held().work)).rejects.toBeInstanceOf(Refusal);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    a.finish();
    await running;
    expect(pass.open()).toBe(0);
  });

  it('never runs more than its slots, and every call settles, whatever the order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 40 }),
        async (costs) => {
          const pass = createPoolGate({ ...WIDE, queued: 16, waitMs: 40 });
          let running = 0;
          let most = 0;
          const all = Promise.allSettled(
            costs.map((cost) =>
              pass.treeWrite(HOME, async () => {
                running += 1;
                most = Math.max(most, running);
                await new Promise((done) => {
                  setTimeout(done, cost);
                });
                running -= 1;
              }),
            ),
          );
          await vi.advanceTimersByTimeAsync(10_000);
          const settled = await all;
          expect(most).toBeLessThanOrEqual(2);
          expect(settled).toHaveLength(costs.length);
          expect(pass.open()).toBe(0);
        },
      ),
    );
  });
});

const busy = (gate: PoolGate, at: TenantRef) => {
  const work = held();
  return { ...work, done: gate.write(at, work.work) };
};

describe('the process wide ceiling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LIMITS: PoolGateLimits = { ...WIDE, ceiling: 8, queued: 64 };

  it('holds tree writes below the ceiling, however many projects are busy', async () => {
    const pass = createPoolGate(LIMITS);
    const writes = Array.from({ length: 30 }, (_, at) => {
      const work = held();
      return { ...work, done: pass.treeWrite(inOrganization(at, at), work.work) };
    });
    await flush();
    expect(writes.filter(({ started }) => started())).toHaveLength(6);
    expect(pass.load()).toEqual({ running: 6, waiting: 24 });
    for (const { finish } of writes) finish();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(writes.map(({ done }) => done));
    expect(pass.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('keeps a quarter of the ceiling for lists, so stalled writes cannot shut them out', async () => {
    const pass = createPoolGate(LIMITS);
    const writes = Array.from({ length: 30 }, (_, at) => busy(pass, inOrganization(at, at)));
    await flush();
    expect(pass.load().running).toBe(6);

    const first = pass.enterList(inOrganization(40, 40));
    const second = pass.enterList(inOrganization(41, 41));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(pass.enterList(inOrganization(42, 42))).toBeNull();

    first?.();
    second?.();
    for (const { finish } of writes) finish();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.allSettled(writes.map(({ done }) => done));
  });

  it('counts lists and writes against one ceiling', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 3 });
    const a = busy(pass, inOrganization(1, 1));
    const leaveB = pass.enterList(inOrganization(2, 2));
    const leaveC = pass.enterList(inOrganization(3, 3));
    await flush();
    expect(pass.load().running).toBe(3);
    expect(pass.enterList(inOrganization(4, 4))).toBeNull();
    a.finish();
    await a.done;
    leaveB?.();
    leaveC?.();
    expect(pass.load().running).toBe(0);
  });

  it('never lets one organization take the whole ceiling, across all its projects', async () => {
    const pass = createPoolGate(LIMITS);
    const writes = Array.from({ length: 30 }, (_, at) => busy(pass, inOrganization(1, at)));
    await flush();
    expect(pass.load().running).toBe(3);

    const quiet = busy(pass, inOrganization(2, 99));
    await flush();
    expect(quiet.started()).toBe(true);

    quiet.finish();
    for (const { finish } of writes) finish();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.allSettled([quiet.done, ...writes.map(({ done }) => done)]);
  });

  it('leaves a quiet fourth organization a place when three take all they can', () => {
    const pass = createPoolGate(LIMITS);
    const taken = [1, 2, 3].flatMap((organization) =>
      Array.from({ length: 4 }, () => pass.enterList(inOrganization(organization, organization))),
    );
    expect(pass.load().running).toBeLessThan(8);
    const quiet = pass.enterList(inOrganization(4, 4));
    expect(quiet).not.toBeNull();
    quiet?.();
    for (const leave of taken) leave?.();
    expect(pass.load().running).toBe(0);
  });

  it('gives a freed place to the first waiter that fits, not to a later arrival', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1 });
    const a = busy(pass, inOrganization(1, 1));
    const b = busy(pass, inOrganization(2, 2));
    const c = busy(pass, inOrganization(3, 3));
    await flush();
    a.finish();
    await a.done;
    await flush();
    expect([b.started(), c.started()]).toEqual([true, false]);
    expect(pass.enterList(inOrganization(4, 4))).toBeNull();
    b.finish();
    await b.done;
    await flush();
    c.finish();
    await c.done;
  });

  it('skips a waiter whose lane is full, so its project does not hold up another', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 2, treeSlots: 1 });
    const [a, b, c] = [held(), held(), held()];
    const first = pass.treeWrite(inOrganization(1, 1), a.work);
    const second = pass.treeWrite(inOrganization(2, 2), b.work);
    const third = pass.treeWrite(inOrganization(1, 1), c.work);
    const d = busy(pass, inOrganization(3, 3));
    await flush();
    expect([c.started(), d.started()]).toEqual([false, false]);
    b.finish();
    await second;
    await flush();
    expect([c.started(), d.started()]).toEqual([false, true]);
    a.finish();
    d.finish();
    await Promise.all([first, d.done]);
    await flush();
    expect(c.started()).toBe(true);
    c.finish();
    await third;
  });

  it('waits off the pool for at most the wait, then refuses and runs nothing', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1 });
    const a = busy(pass, inOrganization(1, 1));
    const late = held();
    const refused = expect(pass.write(inOrganization(2, 2), late.work)).rejects.toMatchObject(
      unavailable,
    );
    expect(pass.load()).toEqual({ running: 1, waiting: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    await refused;
    expect(late.started()).toBe(false);
    expect(pass.load()).toEqual({ running: 1, waiting: 0 });
    a.finish();
    await a.done;
  });

  it('bounds the queue for the whole process, and one organization leaves room in it', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1, queued: 8 });
    const a = busy(pass, inOrganization(1, 1));
    const crowd = Array.from({ length: 4 }, () => busy(pass, inOrganization(2, 2)));
    await expect(pass.write(inOrganization(2, 2), held().work)).rejects.toBeInstanceOf(PoolBusy);
    const quiet = busy(pass, inOrganization(3, 3));
    expect(pass.load().waiting).toBe(5);

    a.finish();
    await a.done;
    for (const { finish } of [...crowd, quiet]) finish();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.allSettled([...crowd, quiet].map(({ done }) => done));
  });

  it('gives a place back when the work throws, and passes the throw on', async () => {
    const pass = createPoolGate(LIMITS);
    const boom = new Error('boom');
    await expect(pass.write(HOME, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(pass.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('holds lists to the cap of an organization below its share', () => {
    const pass = createPoolGate({ ...LIMITS, listsPerOrganization: 2 });
    const first = pass.enterList(HOME);
    const second = pass.enterList(HOME);
    expect(pass.enterList(HOME)).toBeNull();
    first?.();
    second?.();
  });

  it('never queues a list', () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1 });
    const first = pass.enterList(inOrganization(1, 1));
    expect(pass.enterList(inOrganization(2, 2))).toBeNull();
    expect(pass.load()).toEqual({ running: 1, waiting: 0 });
    first?.();
  });

  it('gives a list place back once, however often leave is called', () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1 });
    const first = pass.enterList(HOME);
    first?.();
    first?.();
    expect(pass.load().running).toBe(0);
  });

  it('lets a waiter in when a list leaves', async () => {
    const pass = createPoolGate({ ...LIMITS, ceiling: 1 });
    const leave = pass.enterList(inOrganization(1, 1));
    const a = busy(pass, inOrganization(2, 2));
    await flush();
    expect(a.started()).toBe(false);
    leave?.();
    await flush();
    expect(a.started()).toBe(true);
    a.finish();
    await a.done;
  });

  it('forgets tenants once they are quiet, so the tables cannot grow', async () => {
    const pass = createPoolGate(LIMITS);
    for (let at = 0; at < 100; at += 1) {
      await pass.treeWrite(inOrganization(at, at), () => Promise.resolve());
      pass.enterList(inOrganization(at, at))?.();
    }
    expect(pass.open()).toBe(0);
  });

  it('holds its bounds and settles every call, whatever the order and the tenants', async () => {
    const arrival = fc.record({
      organization: fc.nat({ max: 5 }),
      project: fc.nat({ max: 3 }),
      kind: fc.constantFrom('tree', 'write', 'list'),
      cost: fc.nat({ max: 50 }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.array(arrival, { minLength: 1, maxLength: 60 }),
        async (ceiling, arrivals) => {
          const pass = createPoolGate({ ...WIDE, ceiling, queued: 16, waitMs: 40 });
          const running = new Map<number, number>();
          let total = 0;
          let most = 0;
          let mostOfOne = 0;
          const spend = async (organization: number, cost: number) => {
            const mine = (running.get(organization) ?? 0) + 1;
            running.set(organization, mine);
            total += 1;
            most = Math.max(most, total);
            mostOfOne = Math.max(mostOfOne, mine);
            await new Promise((done) => {
              setTimeout(done, cost);
            });
            running.set(organization, (running.get(organization) ?? 1) - 1);
            total -= 1;
          };
          const all = Promise.allSettled(
            arrivals.map(async ({ organization, project, kind, cost }) => {
              const at = inOrganization(organization, project);
              if (kind === 'tree') await pass.treeWrite(at, () => spend(organization, cost));
              else if (kind === 'write') await pass.write(at, () => spend(organization, cost));
              else {
                const leave = pass.enterList(at);
                if (leave === null) return;
                await spend(organization, cost);
                leave();
              }
            }),
          );
          await vi.advanceTimersByTimeAsync(10_000);
          const settled = await all;
          expect(most).toBeLessThanOrEqual(ceiling);
          expect(mostOfOne).toBeLessThanOrEqual(Math.ceil(ceiling / 2));
          expect(settled).toHaveLength(arrivals.length);
          expect(pass.load()).toEqual({ running: 0, waiting: 0 });
          expect(pass.open()).toBe(0);
        },
      ),
    );
  });

  // Any number of organizations below the room left, in any order of arrivals, leaves a place.
  it('always has a place for a newcomer while three organizations take what they can', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 2 }), { maxLength: 80 }), (order) => {
        const pass = createPoolGate({ ...LIMITS, listsPerOrganization: 8 });
        const leaves = order.map((organization) =>
          pass.enterList(inOrganization(organization, organization)),
        );
        const quiet = pass.enterList(inOrganization(3, 3));
        expect(quiet).not.toBeNull();
        quiet?.();
        for (const leave of leaves) leave?.();
      }),
    );
  });
});

describe('assertCeilingBelowPool', () => {
  it('passes a ceiling under the pool', () => {
    expect(() => {
      assertCeilingBelowPool(9, 10);
    }).not.toThrow();
  });

  it.each([
    [10, 10],
    [11, 10],
    [1, 1],
  ])('refuses a ceiling of %i on a pool of %i, naming both keys', (ceiling, pool) => {
    expect(() => {
      assertCeilingBelowPool(ceiling, pool);
    }).toThrow(/DREFYN_ENGINE_POOL_CEILING.*DREFYN_DATABASE_POOL_MAX/);
  });
});

describe('gateFor', () => {
  const LIMITS: PoolGateLimits = { ...WIDE, ceiling: 8 };

  it('gives one pool one gate, however many engines ask', () => {
    const pool = {};
    expect(gateFor(pool, LIMITS, 10)).toBe(gateFor(pool, LIMITS, 10));
  });

  it('gives each pool a gate of its own', () => {
    expect(gateFor({}, LIMITS, 10)).not.toBe(gateFor({}, LIMITS, 10));
  });

  it('refuses a second set of limits on one pool, as one of them would be ignored', () => {
    const pool = {};
    gateFor(pool, LIMITS, 10);
    expect(() => gateFor(pool, { ...LIMITS, ceiling: 7 }, 10)).toThrow(/one pool/);
  });

  it('compares the ceiling with the pool it will guard', () => {
    expect(() => gateFor({}, LIMITS, 8)).toThrow(/DREFYN_DATABASE_POOL_MAX/);
  });
});
