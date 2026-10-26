// Several fixed seeds, never one: a single pinned seed once hid a wrong assertion because
// it never generated the case that would have failed. Fixed, so a failure reproduces.
export const SEEDS = [1, 42, 4242, 20_261_026, 0x5eed] as const;

// The first 'binary' unit string drawn in a file makes fast-check build a reverse lookup
// over every code point, which has taken up to 4.5 s in CI. Only that test gets the room.
export const FIRST_BINARY_PROPERTY_TIMEOUT_MS = 30_000;
