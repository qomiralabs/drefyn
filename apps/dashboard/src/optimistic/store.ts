// A list that changes before the server answers. It keeps what the server last confirmed and
// the changes still on their way, and what shows is always those changes replayed over that
// confirmed state. So a refusal needs no special rollback: the refused change leaves the list
// and the replay gives the right answer, later changes included.

export interface OptimisticToast {
  readonly title: string;
  readonly description?: string;
  readonly tone?: 'error';
  readonly undo?: () => Promise<void>;
}

export interface OptimisticDeps {
  readonly toast: (input: OptimisticToast) => { close(): void };
  readonly logWarn: (event: string, context: OptimisticLogContext) => void;
  readonly context: { readonly organizationId: string; readonly projectId: string };
}

export interface OptimisticLogContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly action: string;
  readonly count: number;
  readonly reason: string;
}

export interface OptimisticChange<T> {
  // A fixed name for the logs, such as pages.archive. Never built from content.
  readonly action: string;
  readonly ids: readonly string[];
  readonly apply: (item: T) => T;
  // Both answer with the server's copies. A rejection means nothing was written.
  readonly send: () => Promise<readonly T[]>;
  // Gets the exact items from before this change.
  readonly revert: (before: readonly T[]) => Promise<readonly T[]>;
  readonly done: string;
  readonly undone: string;
  readonly failed: string;
  readonly onRollback?: () => void;
}

export interface OptimisticStore<T> {
  readonly get: () => readonly T[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly run: (change: OptimisticChange<T>) => void;
  // Resolves once no request is left. A request can hold up the next, so tests wait on this.
  readonly idle: () => Promise<void>;
}

// A refusal the server explained. The code goes in the logs, so it must never hold content.
export class OptimisticRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'OptimisticRefused';
    this.code = code;
  }
}

interface Entry<T> {
  readonly ids: ReadonlySet<string>;
  readonly apply: (item: T) => T;
  readonly send: () => Promise<readonly T[]>;
  readonly accepted: () => void;
  readonly refused: (reason: unknown) => void;
  // The items as they stood just before this change, refreshed by every replay.
  before: readonly T[];
  undoing?: Entry<T>;
}

// Error messages can quote what they failed on, so only our own codes reach a log line.
const reasonOf = (error: unknown): string =>
  error instanceof OptimisticRefused ? error.code : 'unknown';

export function createOptimisticStore<T extends { readonly id: string }>({
  initial,
  ...deps
}: OptimisticDeps & { readonly initial: readonly T[] }): OptimisticStore<T> {
  let confirmed = initial;
  let visible = initial;
  let draining: Promise<void> = Promise.resolve();
  let running = false;
  const pending: Entry<T>[] = [];
  const listeners = new Set<() => void>();
  // Changes whose Undo can still run. Each withdraws itself.
  const undoable = new Set<{ readonly ids: ReadonlySet<string>; withdraw(): void }>();

  const replay = () => {
    let state = confirmed;
    for (const entry of pending) {
      entry.before = state.filter((item) => entry.ids.has(item.id));
      state = state.map((item) => (entry.ids.has(item.id) ? entry.apply(item) : item));
    }
    visible = state;
    for (const listener of listeners) listener();
  };

  const adopt = (items: readonly T[]) => {
    const answered = new Map(items.map((item) => [item.id, item]));
    confirmed = confirmed.map((item) => answered.get(item.id) ?? item);
  };

  // One request at a time. Two in flight could land in either order, and the server would end
  // on a different value from the one on screen.
  const drain = async () => {
    for (let entry = pending[0]; entry !== undefined; entry = pending[0]) {
      try {
        adopt(await entry.send());
        pending.shift();
        replay();
        entry.accepted();
      } catch (error) {
        pending.shift();
        const undoing = entry.undoing;
        if (undoing !== undefined) pending.splice(pending.indexOf(undoing), 1);
        replay();
        entry.refused(error);
        undoing?.accepted();
      }
    }
    running = false;
  };

  const enqueue = (entry: Entry<T>) => {
    pending.push(entry);
    replay();
    if (running) return;
    running = true;
    draining = drain();
  };

  const warn = (event: string, change: OptimisticChange<T>, error: unknown) => {
    deps.logWarn(event, {
      ...deps.context,
      action: change.action,
      count: change.ids.length,
      reason: reasonOf(error),
    });
  };

  const run = (change: OptimisticChange<T>) => {
    const ids = new Set(change.ids);
    // Undoing an older change now would throw away this one, so its Undo goes.
    for (const older of undoable) {
      if ([...older.ids].some((id) => ids.has(id))) older.withdraw();
    }
    const entry: Entry<T> = {
      ids,
      apply: change.apply,
      send: change.send,
      before: [],
      accepted: () => undefined,
      refused: (error) => {
        withdraw();
        warn('optimistic.refused', change, error);
        // Undone already, so the person has what they asked for and no error to read.
        if (entry.undoing !== undefined) return;
        change.onRollback?.();
        deps.toast({
          title: change.failed,
          description: 'Nothing changed. Try again.',
          tone: 'error',
        });
      },
    };

    const undo = () => {
      if (!undoable.delete(mark)) return Promise.resolve();
      const said = deps.toast({ title: change.undone });
      return new Promise<void>((resolve, reject) => {
        const snapshot = new Map(entry.before.map((item) => [item.id, item]));
        entry.undoing = {
          ids,
          apply: (item) => snapshot.get(item.id) ?? item,
          send: () => change.revert(entry.before),
          before: [],
          accepted: resolve,
          refused: (error) => {
            said.close();
            warn('optimistic.undo_refused', change, error);
            reject(error instanceof Error ? error : new Error('undo refused'));
          },
        };
        enqueue(entry.undoing);
      });
    };

    // The toast comes first: a request can fail before enqueue returns, and that closes it.
    const shown = deps.toast({ title: change.done, undo });
    const mark = { ids, withdraw };
    function withdraw() {
      undoable.delete(mark);
      shown.close();
    }
    undoable.add(mark);
    enqueue(entry);
  };

  return {
    get: () => visible,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    run,
    idle: () => draining,
  };
}
