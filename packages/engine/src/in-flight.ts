export interface InFlightLimit {
  // A place for one piece of work, returned by the function it gives back, or null when full.
  enter(key: string): (() => void) | null;
  keys(): number;
}

// Refuses rather than queues: a waiting query would only move the pile up to somewhere with no
// bound. A key with nothing running is dropped, so the table is only as big as the work.
export function inFlightLimit(max: number): InFlightLimit {
  const running = new Map<string, number>();
  return {
    enter(key) {
      const count = running.get(key) ?? 0;
      if (count >= max) return null;
      running.set(key, count + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const remaining = (running.get(key) ?? 1) - 1;
        if (remaining === 0) running.delete(key);
        else running.set(key, remaining);
      };
    },
    keys: () => running.size,
  };
}
