import { describe, expect, it, vi } from 'vitest';
import {
  createOptimisticStore,
  OptimisticRefused,
  type OptimisticChange,
  type OptimisticDeps,
  type OptimisticToast,
} from '../src/optimistic/store.ts';

interface Item {
  readonly id: string;
  readonly value: string;
}

const START: readonly Item[] = [
  { id: 'a', value: 'one' },
  { id: 'b', value: 'two' },
];

// A request the test answers by hand, so it can look at the screen while one is in flight.
function deferred() {
  let accept!: (items: readonly Item[]) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise<readonly Item[]>((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  return { promise, accept, refuse };
}

interface Shown extends OptimisticToast {
  closed: boolean;
}

function setup() {
  const shown: Shown[] = [];
  const logWarn = vi.fn<OptimisticDeps['logWarn']>();
  const store = createOptimisticStore<Item>({
    initial: START,
    context: { organizationId: 'org_acme', projectId: 'prj_payments' },
    logWarn,
    toast: (input) => {
      const entry: Shown = { ...input, closed: false };
      shown.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
  });
  const open = () => shown.filter((t) => !t.closed);
  return { store, shown, open, logWarn };
}

function change(overrides: Partial<OptimisticChange<Item>> = {}): OptimisticChange<Item> {
  return {
    action: 'items.set',
    ids: ['a'],
    apply: (item) => ({ ...item, value: 'changed' }),
    send: () => Promise.resolve([{ id: 'a', value: 'changed' }]),
    revert: (before) => Promise.resolve(before),
    done: 'Changed one.',
    undone: 'One is back.',
    failed: 'Could not change one.',
    ...overrides,
  };
}

const valueOf = (items: readonly Item[], id: string) => items.find((i) => i.id === id)?.value;

describe('applying a change', () => {
  it('shows it before the server answers, with a toast that offers Undo', async () => {
    const { store, open } = setup();
    const request = deferred();
    store.run(change({ send: () => request.promise }));
    expect(valueOf(store.get(), 'a')).toBe('changed');
    expect(valueOf(store.get(), 'b')).toBe('two');
    expect(open().map((t) => t.title)).toEqual(['Changed one.']);
    expect(open()[0]?.undo).toBeTypeOf('function');
    request.accept([{ id: 'a', value: 'changed' }]);
    await store.idle();
    expect(open()).toHaveLength(1);
  });

  it('tells subscribers each time what is visible changes', async () => {
    const { store } = setup();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.run(change());
    expect(heard).toHaveBeenCalledTimes(1);
    await store.idle();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    store.run(change());
    expect(heard).toHaveBeenCalledTimes(2);
    await store.idle();
  });

  it('keeps the same snapshot between changes, as React asks of an external store', async () => {
    const { store } = setup();
    expect(store.get()).toBe(store.get());
    store.run(change());
    await store.idle();
    expect(store.get()).toBe(store.get());
  });

  it('takes what the server answered over its own guess', async () => {
    const { store } = setup();
    store.run(change({ send: () => Promise.resolve([{ id: 'a', value: 'as saved' }]) }));
    expect(valueOf(store.get(), 'a')).toBe('changed');
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('as saved');
  });

  it('ignores items the server answers with that it does not hold', async () => {
    const { store } = setup();
    store.run(change({ send: () => Promise.resolve([{ id: 'x', value: 'stray' }]) }));
    await store.idle();
    expect(store.get().map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('sends one request at a time, in the order they were made', async () => {
    const { store } = setup();
    const first = deferred();
    const second = deferred();
    const secondSend = vi.fn(() => second.promise);
    store.run(change({ send: () => first.promise }));
    store.run(change({ send: secondSend }));
    await Promise.resolve();
    expect(secondSend).not.toHaveBeenCalled();
    first.accept([{ id: 'a', value: 'changed' }]);
    await vi.waitFor(() => {
      expect(secondSend).toHaveBeenCalledTimes(1);
    });
    second.accept([{ id: 'a', value: 'changed' }]);
    await store.idle();
  });
});

describe('undo', () => {
  it('restores the state before the change exactly, here and on the server', async () => {
    const { store, open } = setup();
    const revert = vi.fn((before: readonly Item[]) => Promise.resolve(before));
    const before = store.get();
    store.run(change({ revert }));
    await store.idle();
    await open()[0]?.undo?.();
    await store.idle();
    expect(store.get()).toEqual(before);
    expect(revert).toHaveBeenCalledWith([{ id: 'a', value: 'one' }]);
  });

  it('restores at once, before the server answers, and says so', async () => {
    const { store, open } = setup();
    const request = deferred();
    store.run(change({ revert: () => request.promise }));
    await store.idle();
    const undoing = open()[0]?.undo?.();
    expect(valueOf(store.get(), 'a')).toBe('one');
    expect(open().map((t) => t.title)).toContain('One is back.');
    request.accept([{ id: 'a', value: 'one' }]);
    await undoing;
  });

  it('works while the change is still on its way', async () => {
    const { store, open } = setup();
    const request = deferred();
    const revert = vi.fn((before: readonly Item[]) => Promise.resolve(before));
    store.run(change({ send: () => request.promise, revert }));
    const undoing = open()[0]?.undo?.();
    expect(valueOf(store.get(), 'a')).toBe('one');
    request.accept([{ id: 'a', value: 'changed' }]);
    await undoing;
    await store.idle();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(valueOf(store.get(), 'a')).toBe('one');
  });

  it('reverts once however many times it is pressed', async () => {
    const { store, shown } = setup();
    const revert = vi.fn((before: readonly Item[]) => Promise.resolve(before));
    store.run(change({ revert }));
    await store.idle();
    const undo = shown[0]?.undo;
    await undo?.();
    await undo?.();
    await store.idle();
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('rolls back and leaves the words to the toast when the server refuses it', async () => {
    const { store, open, shown, logWarn } = setup();
    store.run(change({ revert: () => Promise.reject(new OptimisticRefused('conflict')) }));
    await store.idle();
    const undoing = open()[0]?.undo?.();
    expect(valueOf(store.get(), 'a')).toBe('one');
    await expect(undoing).rejects.toBeInstanceOf(OptimisticRefused);
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('changed');
    expect(shown.find((t) => t.title === 'One is back.')?.closed).toBe(true);
    expect(shown.filter((t) => t.tone === 'error')).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      'optimistic.undo_refused',
      expect.objectContaining({ action: 'items.set', reason: 'conflict' }),
    );
  });

  it('leaves untouched objects alone', async () => {
    const { store, open } = setup();
    store.run(change());
    store.run(
      change({
        ids: ['b'],
        apply: (item) => ({ ...item, value: 'other' }),
        send: () => Promise.resolve([{ id: 'b', value: 'other' }]),
      }),
    );
    await store.idle();
    await open()[0]?.undo?.();
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('one');
    expect(valueOf(store.get(), 'b')).toBe('other');
  });

  it('is withdrawn when a newer change touches the same object', async () => {
    const { store, shown, open } = setup();
    store.run(change());
    const older = shown[0];
    store.run(
      change({
        apply: (item) => ({ ...item, value: 'newer' }),
        send: () => Promise.resolve([{ id: 'a', value: 'newer' }]),
      }),
    );
    expect(older?.closed).toBe(true);
    expect(open()).toHaveLength(1);
    await store.idle();
    await older?.undo?.();
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('newer');
  });

  it('restores the state a refused change left, not the one it hoped for', async () => {
    const { store, open } = setup();
    const first = deferred();
    store.run(change({ send: () => first.promise }));
    store.run(
      change({
        apply: (item) => ({ ...item, value: 'newer' }),
        send: () => Promise.resolve([{ id: 'a', value: 'newer' }]),
      }),
    );
    first.refuse(new OptimisticRefused('conflict'));
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('newer');
    await open()
      .find((t) => t.undo !== undefined)
      ?.undo?.();
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('one');
  });
});

describe('a refusal', () => {
  it('rolls back, drops the Undo and shows an error toast', async () => {
    const { store, open, shown } = setup();
    const onRollback = vi.fn();
    const before = store.get();
    store.run(
      change({ send: () => Promise.reject(new OptimisticRefused('conflict')), onRollback }),
    );
    expect(valueOf(store.get(), 'a')).toBe('changed');
    await store.idle();
    expect(store.get()).toEqual(before);
    expect(shown[0]?.closed).toBe(true);
    expect(open().map((t) => [t.title, t.description, t.tone])).toEqual([
      ['Could not change one.', 'Nothing changed. Try again.', 'error'],
    ]);
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it('keeps later changes on the same object, replayed over the real state', async () => {
    const { store } = setup();
    const first = deferred();
    store.run(
      change({ send: () => first.promise, apply: (i) => ({ ...i, value: `${i.value}+a` }) }),
    );
    store.run(
      change({
        apply: (i) => ({ ...i, value: `${i.value}+b` }),
        send: () => Promise.resolve([{ id: 'a', value: 'one+b' }]),
      }),
    );
    expect(valueOf(store.get(), 'a')).toBe('one+a+b');
    first.refuse(new OptimisticRefused('conflict'));
    await vi.waitFor(() => {
      expect(valueOf(store.get(), 'a')).toBe('one+b');
    });
    await store.idle();
  });

  it('counts a request that throws before it starts', async () => {
    const { store, open } = setup();
    store.run(
      change({
        send: () => {
          throw new Error('no network');
        },
      }),
    );
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('one');
    expect(open().map((t) => t.tone)).toEqual(['error']);
  });

  it('stays quiet when the person already undid the change', async () => {
    const { store, open, shown } = setup();
    const request = deferred();
    const revert = vi.fn((before: readonly Item[]) => Promise.resolve(before));
    store.run(change({ send: () => request.promise, revert }));
    const undoing = open()[0]?.undo?.();
    request.refuse(new OptimisticRefused('conflict'));
    await undoing;
    await store.idle();
    expect(valueOf(store.get(), 'a')).toBe('one');
    expect(shown.filter((t) => t.tone === 'error')).toEqual([]);
    expect(revert).not.toHaveBeenCalled();
  });
});

describe('log context', () => {
  it('carries the organization and project and no content', async () => {
    const { store, logWarn } = setup();
    store.run(
      change({
        ids: ['a', 'b'],
        send: () => Promise.reject(new OptimisticRefused('conflict')),
      }),
    );
    await store.idle();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith('optimistic.refused', {
      organizationId: 'org_acme',
      projectId: 'prj_payments',
      action: 'items.set',
      count: 2,
      reason: 'conflict',
    });
  });

  it('never repeats an error message, which could hold content', async () => {
    const { store, logWarn } = setup();
    const secret = 'Refunds page body with maya@acme.dev';
    store.run(change({ send: () => Promise.reject(new Error(secret)) }));
    await store.idle();
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('maya');
    expect(logWarn.mock.calls[0]?.[1]).toMatchObject({ reason: 'unknown' });
  });

  it('never carries the words shown to the person', async () => {
    const { store, logWarn } = setup();
    store.run(change({ send: () => Promise.reject(new Error('no')) }));
    await store.idle();
    const line = JSON.stringify(logWarn.mock.calls);
    expect(line).not.toContain('Could not change one');
    expect(line).not.toContain('changed');
  });
});
