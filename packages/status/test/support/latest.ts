import type { CheckOutcome, ControlResult, RegionReport } from '../../src/index.ts';

export interface Result {
  probeId: string;
  region: string;
  monitorId: string;
  scheduledAt: number;
  receivedAt: number;
  outcome: CheckOutcome;
  control?: ControlResult;
}

// The latest table as ingest keeps it: one row per monitor and region, moving only forward
// on scheduledAt, with outcomeSince kept while the outcome repeats.
export class LatestTable {
  private readonly rows = new Map<string, RegionReport>();

  upsert(result: Result): void {
    const key = `${result.monitorId}\u0000${result.region}`;
    const row = this.rows.get(key);
    if (row !== undefined && !(result.scheduledAt > row.scheduledAt)) return;
    this.rows.set(key, {
      ...result,
      outcomeSince: row?.outcome === result.outcome ? row.outcomeSince : result.scheduledAt,
    });
  }

  reports(): RegionReport[] {
    return [...this.rows.values()];
  }
}

// mulberry32: small, seedable and free of the short gap after a rare draw that MINSTD has.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
