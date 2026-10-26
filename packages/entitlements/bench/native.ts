// Times checkLimit in plain Node. The vitest bench runs inside a module runner that wraps
// every import in a getter, which it warns about and which adds to each call, so this is
// the number to hold against the per call budget. Run: node bench/native.ts
import { checkLimit } from '../src/index.ts';
import type { CheckOptions } from '../src/index.ts';
import { finiteMap, unlimitedMap } from './maps.ts';

const CALLS = 1_000_000;
const ROUNDS = 21;
const PER_ROUND = CALLS / (ROUNDS - 1);

const cases: readonly (readonly [string, CheckOptions | undefined])[] = [
  ['21 key map, finite cap', { overrides: finiteMap, graceEligible: true }],
  ['21 key map, unlimited cap', { overrides: unlimitedMap, graceEligible: true }],
  ['no overrides', undefined],
];

for (const [label, options] of cases) {
  const run = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      checkLimit('enterprise', 'status.email_sends_per_month', 2001, options);
    }
  };
  run(100_000);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run(PER_ROUND);
    samples.push(Number(process.hrtime.bigint() - start) / PER_ROUND);
  }
  samples.sort((a, b) => a - b);
  const median = samples[(ROUNDS - 1) / 2] ?? Number.NaN;
  process.stdout.write(`checkLimit, ${label}: median ${median.toFixed(0)} ns per call\n`);
}
process.stdout.write(
  `node ${process.version}, ${String(ROUNDS)} rounds of ${String(PER_ROUND)} calls\n`,
);
