// Several fixed seeds, never one: a single pinned seed once hid a wrong assertion because
// it never generated the case that would have failed. Fixed, so a failure reproduces.
export const SEEDS = [1, 42, 4242, 20_261_026, 0x5eed] as const;
