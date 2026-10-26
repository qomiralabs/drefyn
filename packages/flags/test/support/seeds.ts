// Several fixed seeds, never one: a single pinned seed once hid a wrong assertion because
// it never generated the case that would have failed. Fixed, so a failure reproduces.
export const SEEDS = [1, 42, 4242, 20_261_026, 0x5eed] as const;

// The first 'binary' unit string drawn in a file makes fast-check build a reverse lookup
// over every code point, which has taken up to 4.5 s in CI. Only that test gets the room.
export const FIRST_BINARY_PROPERTY_TIMEOUT_MS = 30_000;

// The provider failure property runs 60 async scenarios on fake timers: 22 to 49 ms per seed
// here, about 250 ms with the worker held to 5 percent of a CPU, and 1.1 to 6.8 s at 1
// percent, where the 5 s default timed out. A host with a load average near 170 gives a
// test runner that little. Fake timers and a fixed seed make every run identical, so the
// only thing load can change is how long it takes.
export const PROVIDER_PROPERTY_TIMEOUT_MS = 30_000;
