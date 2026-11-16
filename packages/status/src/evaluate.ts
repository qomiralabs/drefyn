import type {
  ComponentState,
  CurrentState,
  Decision,
  MonitorId,
  NoChangeReason,
  RegionId,
  RegionReport,
  ReportRef,
  RuleConfig,
} from './types.ts';

type Vote = 'down' | 'up' | null;

const unchanged = (reason: NoChangeReason): Decision => ({ kind: 'no_change', reason });

// Even a config that asks for less never lets one region decide, unless the team opted in.
export function voteFloor(cfg: Pick<RuleConfig, 'minRegions' | 'singleRegionOptIn'>): number {
  return Math.max(cfg.singleRegionOptIn ? 1 : 2, cfg.minRegions);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A total order, so the report kept for a region never depends on the order reports arrive.
function newer(a: RegionReport, b: RegionReport): boolean {
  if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt > b.scheduledAt;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  if (a.outcomeSince !== b.outcomeSince) return a.outcomeSince > b.outcomeSince;
  return (
    compareText(
      `${a.probeId}\u0000${a.outcome}\u0000${a.control ?? ''}`,
      `${b.probeId}\u0000${b.outcome}\u0000${b.control ?? ''}`,
    ) > 0
  );
}

// Written as "not inside" so a NaN timestamp reads as stale, never as fresh.
function isFresh(report: RegionReport, now: number, freshnessMs: number): boolean {
  return now - report.receivedAt <= freshnessMs && now - report.scheduledAt <= freshnessMs;
}

function hasHeld(report: RegionReport, minAgreementMs: number): boolean {
  // Probe time on both sides: a first bad check has held for zero, however late it arrives.
  return report.scheduledAt - report.outcomeSince >= minAgreementMs;
}

function voteOf(down: number, up: number, monitors: number, need: number): Vote {
  if (down >= need) return 'down';
  // Up only on healthy evidence, and only when the monitors not seen healthy could not
  // reach the rule between them.
  if (up > 0 && monitors - up < need) return 'up';
  return null;
}

function desired(
  down: number,
  up: number,
  floor: number,
  downState: ComponentState,
): ComponentState | null {
  // Down wins a tie of quorums: a partial outage seen by enough regions is still an outage.
  if (down >= floor) return downState;
  if (up >= floor) return 'operational';
  return null;
}

function refOf(report: RegionReport): ReportRef {
  return {
    probeId: report.probeId,
    region: report.region,
    monitorId: report.monitorId,
    scheduledAt: report.scheduledAt,
    outcome: report.outcome,
  };
}

// The held reports behind the vote, from each region whose held vote it was.
function evidenceFor(
  voters: readonly ReadonlyMap<MonitorId, RegionReport>[],
  vote: 'down' | 'up',
  minAgreementMs: number,
): ReportRef[] {
  const refs: ReportRef[] = [];
  for (const byMonitor of voters) {
    for (const report of byMonitor.values()) {
      const supports = vote === 'down' ? report.outcome === 'down' : isHealthy(report);
      if (supports && hasHeld(report, minAgreementMs)) refs.push(refOf(report));
    }
  }
  return refs.sort(
    (a, b) => compareText(a.region, b.region) || compareText(a.monitorId, b.monitorId),
  );
}

function isHealthy(report: RegionReport): boolean {
  return report.outcome === 'up' || report.outcome === 'degraded';
}

// Pure: the same inputs always give the same decision, and nothing here reads a clock.
export function evaluate(
  cfg: RuleConfig,
  reports: readonly RegionReport[],
  quarantined: ReadonlySet<RegionId>,
  current: CurrentState,
  now: number,
  killSwitchAutoOff: boolean,
): Decision {
  if (current.state === 'under_maintenance') return unchanged('maintenance');
  const floor = voteFloor(cfg);

  const monitors = new Set<MonitorId>();
  const known = new Set<RegionId>();
  const fresh = new Map<RegionId, Map<MonitorId, RegionReport>>();
  for (const report of reports) {
    monitors.add(report.monitorId);
    if (quarantined.has(report.region)) continue;
    known.add(report.region);
    if (!isFresh(report, now, cfg.freshnessMs)) continue;
    let byMonitor = fresh.get(report.region);
    if (byMonitor === undefined) {
      byMonitor = new Map();
      fresh.set(report.region, byMonitor);
    }
    const kept = byMonitor.get(report.monitorId);
    if (kept === undefined || newer(report, kept)) byMonitor.set(report.monitorId, report);
  }
  if (known.size < floor) return unchanged('insufficient_regions');
  if (fresh.size < floor) return unchanged('not_fresh');

  const total = monitors.size;
  const need =
    cfg.kind === 'all_down'
      ? total
      : cfg.kind === 'threshold'
        ? Math.max(1, cfg.threshold ?? 1)
        : 1;

  const heldVoters = {
    down: [] as Map<MonitorId, RegionReport>[],
    up: [] as Map<MonitorId, RegionReport>[],
  };
  let controlFailed = 0;
  let looseDown = 0;
  let looseUp = 0;
  for (const byMonitor of fresh.values()) {
    let down = 0;
    let up = 0;
    let downHeld = 0;
    let upHeld = 0;
    let fleetFault = false;
    for (const report of byMonitor.values()) {
      if (report.outcome === 'error') {
        // An error is a probe problem, not a target problem, so it never votes. With the
        // control failed it is a fleet fault, which holds state.
        if (report.control === 'failed') fleetFault = true;
        continue;
      }
      const held = hasHeld(report, cfg.minAgreementMs);
      if (report.outcome === 'down') {
        down++;
        if (held) downHeld++;
      } else {
        up++;
        if (held) upHeld++;
      }
    }
    if (fleetFault) {
      controlFailed++;
      continue;
    }
    const loose = voteOf(down, up, total, need);
    const held = voteOf(downHeld, upHeld, total, need);
    if (loose === 'down') looseDown++;
    if (loose === 'up') looseUp++;
    if (held !== null) heldVoters[held].push(byMonitor);
  }

  // Too few regions with working controls leaves no quorum, and that reads as a fleet fault.
  const target = desired(looseDown, looseUp, floor, cfg.downState);
  if (target === null)
    return unchanged(controlFailed > 0 ? 'control_failed' : 'insufficient_regions');
  if (target === current.state) return unchanged('agrees');
  if (!(now - current.since >= cfg.minDwellMs)) return unchanged('dwell');
  const heldTarget = desired(heldVoters.down.length, heldVoters.up.length, floor, cfg.downState);
  if (heldTarget !== target) return unchanged('agreement');
  const vote = target === 'operational' ? 'up' : 'down';

  return {
    kind: cfg.mode === 'apply' && !killSwitchAutoOff ? 'apply' : 'propose',
    from: current.state,
    to: target,
    evidence: evidenceFor(heldVoters[vote], vote, cfg.minAgreementMs),
  };
}
