export interface Queued {
  readonly id: string;
  readonly receivedAt: Date;
}

// Newest first: the later arrival, then the later uuidv7 id, which is the order the claim's
// index reads in. Ids are lower case hex, so string order is byte order.
export function newestFirst(a: Queued, b: Queued): number {
  const time = b.receivedAt.getTime() - a.receivedAt.getTime();
  if (time !== 0) return time;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// The rule the claim applies in SQL. A worker converges on the branch head whichever push
// woke it, so only the newest queued delivery runs and the older ones are done unread.
export function coalesce<T extends Queued>(
  queued: readonly T[],
): { readonly claim: T | null; readonly superseded: readonly T[] } {
  const [claim, ...superseded] = [...queued].sort(newestFirst);
  return { claim: claim ?? null, superseded };
}
