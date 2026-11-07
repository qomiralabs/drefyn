const DEFAULT_LIMIT_MS = 600_000;
const MAX_TICK_MS = 1_000;
const MIN_TICKS = 4;

export function limitFrom(value: string | undefined): number {
  return /^[1-9][0-9]*$/.test(value ?? '') ? Number(value) : DEFAULT_LIMIT_MS;
}

export function ticksFor(limitMs: number) {
  const tickMs = Math.min(MAX_TICK_MS, limitMs / MIN_TICKS);
  return { tickMs, limitTicks: Math.ceil(limitMs / tickMs) };
}

export type Reason = 'stalled' | 'orphaned';

export interface WatchDeps {
  beat(): number;
  parent(): number;
  wait(): void;
}

export interface WatchPlan {
  readonly parent: number;
  readonly limitTicks: number;
}

// Counts its own ticks, not clock time: a laptop lid or a SIGSTOP freezes this and the test
// alike, and must not read as a stall when both wake.
export function watch(deps: WatchDeps, { parent, limitTicks }: WatchPlan): Reason {
  let last = deps.beat();
  let quiet = 0;
  for (;;) {
    deps.wait();
    if (deps.parent() !== parent) return 'orphaned';
    const beat = deps.beat();
    quiet = beat === last ? quiet + 1 : 0;
    last = beat;
    if (quiet >= limitTicks) return 'stalled';
  }
}

export interface Ending {
  readonly pid: number;
  readonly limitMs: number;
  readonly write: (message: string) => void;
  readonly kill: () => void;
}

export function end(reason: Reason, { pid, limitMs, write, kill }: Ending): void {
  try {
    write(
      reason === 'stalled'
        ? `test watchdog: worker ${String(pid)} blocked its event loop for ${String(limitMs)} ms, killing it\n`
        : `test watchdog: the run that started worker ${String(pid)} is gone, killing it\n`,
    );
  } finally {
    // In the finally: with the run gone that pipe has no reader, and the write throws.
    kill();
  }
}

export interface Guard {
  readonly cell: Int32Array;
  readonly parent: number;
  readonly limitMs: number;
}

const IDLE = 1;

// Blocks for good, so it only ever runs on a thread of its own.
export function guard({ cell, parent, limitMs }: Guard, ending: Omit<Ending, 'limitMs'>): void {
  const { tickMs, limitTicks } = ticksFor(limitMs);
  const reason = watch(
    {
      beat: () => Atomics.load(cell, 0),
      parent: () => process.ppid,
      wait: () => {
        Atomics.wait(cell, IDLE, 0, tickMs);
      },
    },
    { parent, limitTicks },
  );
  end(reason, { ...ending, limitMs });
}
