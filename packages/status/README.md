# `@drefyn/status`

The status rule engine. It decides whether a component should change state from the
newest probe report per monitor and region. A component goes down, or recovers, only when
enough distinct regions agree, each region has held its outcome across two checks, and the
fleet's control checks did not fail. The engine is a pure function: it reads no clock, no
flag and no store, so the same inputs always give the same decision.

Self hosting: open core with no hosted dependency. The caller reads the flags and the
latest reports and passes them in.

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `evaluate(cfg, reports, quarantined, current, now, killSwitchAutoOff)` returns a
  `Decision`: `no_change` with a reason, or `propose` or `apply` with `from`, `to` and the
  report refs that carried the vote. Checks run in this order:
  1. `maintenance`: the component is `under_maintenance`.
  2. `insufficient_regions`: fewer distinct, non quarantined regions reported than the vote
     floor.
  3. `not_fresh`: fewer regions than the floor have a report inside `freshnessMs` on both
     `receivedAt` and `scheduledAt`. A report fresh on the server clock but old on the
     probe clock is a drained buffer and never votes.
  4. `control_failed` or `insufficient_regions`: no quorum forms for any state. It is
     `control_failed` when any region's report is an `error` with a failed control, since
     that is a fleet fault and must hold state.
  5. `agrees`: the quorum confirms the current state.
  6. `dwell`: the component changed state less than `minDwellMs` ago.
  7. `agreement`: the quorum only forms when first checks count. Each voting report must
     have `scheduledAt - outcomeSince >= minAgreementMs`, which with the default of one
     interval means two consecutive checks.
  8. `apply` when `cfg.mode` is `apply` and the kill switch allows it, otherwise `propose`.
- Votes: a region counts once, through its newest fresh report per monitor. `down` votes
  for the rule; `up` and `degraded` are healthy; a plain `error` does not vote. Rule kinds
  `any_down`, `all_down` and `threshold` count down monitors within one region. A region
  votes up only on healthy reports, and only when the monitors it did not see healthy could
  not reach the rule. When down and up quorums both form, down wins.
- `voteFloor(cfg)`: the number of regions a change needs, never under 2 unless
  `singleRegionOptIn`, whatever `minRegions` says.
- `defaultMinRegions(assigned, singleRegionOptIn, { majorityDefault } = off)`: 1 with the
  opt in, 2 while `status.majority_default` is off, otherwise
  `max(2, ceil(assigned / 2))`. For new monitors only.
- `newRuleConfig(input, flags)`: a rule for a new monitor. Freshness and dwell are two
  intervals, agreement is one, and `mode` is `propose` unless `status.auto_apply_default`
  is on.
- `parseRuleConfig(value)`: validates a stored rule with zod and returns it unchanged, so
  a stored rule keeps its values when a default flag changes. Bad input throws
  `StatusError` with code `STATUS_RULE_INVALID`.
- `applyControl(outcome, control, flags)`: the outcome ingest stores. `error` when the
  control failed and `status.control_checks` is on; otherwise the outcome as reported.
- `autoStateChangesOff(flags)`: the `killSwitchAutoOff` argument from the
  `status.auto_state_changes` kill switch.
- `StatusFlags` and `SAFE_STATUS_FLAGS`: the four status flags as booleans, all off.

## Flags

All four are off in production.

| Flag                        | Kind        | Off means                                                       |
| --------------------------- | ----------- | --------------------------------------------------------------- |
| `status.auto_state_changes` | kill switch | Every rule proposes; nothing applies                            |
| `status.control_checks`     | release     | Observe mode: the control result is kept and changes no outcome |
| `status.majority_default`   | release     | New monitors need two regions                                   |
| `status.auto_apply_default` | release     | New rules propose                                               |

## Commands

- `pnpm --filter @drefyn/status test`: unit, property, replay and buffer drain tests with
  coverage, at least 95 percent of lines.
- `pnpm --filter @drefyn/status test:mutation`: Stryker over the engine, defaults and
  config; fails when more than 10 percent of mutants survive.
- `pnpm --filter @drefyn/status bench`: `evaluate` at 6 regions with 1 and 200 monitors;
  fails when p99 reaches 1 ms. Timings depend on the machine, so CI does not run it.

The replay test runs weeks of synthetic noise with assumed rates and no real outage. With a
perfect control fixture it gives no false flip. Without a control it flips on every fleet
fault, and that count is pinned as a known residual, not a pass.
