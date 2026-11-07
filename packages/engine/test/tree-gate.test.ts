import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Refusal } from '../src/errors.ts';
import { createTreeGate } from '../src/tree-gate.ts';

const tenant = (project: number): TenantRef => ({
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId(`01890a5d-ac96-774b-bcce-b302099a${String(9000 + project)}`),
});
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

describe('createTreeGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const gate = () => createTreeGate({ slots: 2, queued: 2, waitMs: 1000 });

  it('runs up to its slots at once and queues the rest in order', async () => {
    const pass = gate();
    const [a, b, c, d] = [held(), held(), held(), held()];
    const all = [a, b, c, d].map(({ work }) => pass.through(HOME, work));
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
    const all = first.map(({ work }) => pass.through(HOME, work));
    const late = held();
    await expect(pass.through(HOME, late.work)).rejects.toMatchObject(unavailable);
    expect(late.started()).toBe(false);
    for (const { finish } of first) finish();
    await flush();
    await Promise.all(all);
  });

  it('gives up on a wait, and the place is free again', async () => {
    const pass = gate();
    const [a, b, c] = [held(), held(), held()];
    const running = [pass.through(HOME, a.work), pass.through(HOME, b.work)];
    const waiting = pass.through(HOME, c.work);
    const outcome = expect(waiting).rejects.toBeInstanceOf(Refusal);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(c.started()).toBe(false);

    const d = held();
    const next = pass.through(HOME, d.work);
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
    const busy = [pass.through(HOME, a.work), pass.through(HOME, b.work)];
    const free = pass.through(OTHER, c.work);
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
    await expect(pass.through(HOME, () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(pass.through(HOME, () => Promise.resolve(7))).resolves.toBe(7);
    expect(pass.open()).toBe(0);
  });

  it('forgets a project once it is quiet, so the map cannot grow with tenants', async () => {
    const pass = gate();
    const a = held();
    const running = pass.through(HOME, a.work);
    expect(pass.open()).toBe(1);
    a.finish();
    await running;
    expect(pass.open()).toBe(0);
  });

  it('forgets a project whose last waiter gave up before the work ended', async () => {
    const pass = createTreeGate({ slots: 1, queued: 1, waitMs: 1000 });
    const a = held();
    const running = pass.through(HOME, a.work);
    const waiting = expect(pass.through(HOME, held().work)).rejects.toBeInstanceOf(Refusal);
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
          const pass = createTreeGate({ slots: 2, queued: 8, waitMs: 40 });
          let running = 0;
          let most = 0;
          const all = Promise.allSettled(
            costs.map((cost) =>
              pass.through(HOME, async () => {
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
