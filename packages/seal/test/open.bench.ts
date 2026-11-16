// Cost of opening one 100 byte secret, the size of a provider API key with room to spare.
// The budget is under 0.1 ms per open; read the mean and p99 columns. Not a gate in CI:
// timings depend on the machine.
import { test } from 'vitest';
import { aesGcmSealer } from '../src/index.ts';

const sealer = aesGcmSealer(
  [{ id: 'k1', material: new Uint8Array(32).fill(7) }],
  { hkdfSalt: 'drefyn.bench.v1', hkdfInfo: 'drefyn/bench/v1', aadVersion: 'drefyn.bench.v1' },
  'DREFYN_BENCH_KEYS',
);
const bound = ['0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f', '01934c1e-7a2b-7c3d-8e4f-5a6b7c8d9e0f'];
const plain = new Uint8Array(100).fill(9);
const row = sealer.seal(plain, bound);

test('seal and open cost per call', async ({ bench }) => {
  await bench.compare(
    bench('open a 100 byte secret', () => {
      sealer.open(row, bound);
    }),
    bench('seal a 100 byte secret', () => {
      sealer.seal(plain, bound);
    }),
    { iterations: 50_000, time: 0, warmupIterations: 5_000 },
  );
});
