import { expect, it, describe } from 'vitest';
import { ARGON2_FLOOR, createPasswordHasher } from '../../../src/index.ts';

// Verify latency at the default parameters with 4 hashes in flight, the default hash
// concurrency. No database: this is the hash and the gate. CI checks the median and a far
// ceiling; the 50 ms p99 target is read on quiet hardware from the printed line, as the
// shared runner's tail belongs to its neighbours.

const SAMPLES = Number(process.env['DREFYN_AUTH_VERIFY_SAMPLES'] ?? '400');
const CONCURRENT = 4;
// CI ceilings: a shared runner's hashes compete for its CPUs. The 50 ms target is measured
// on quiet hardware.
const VERIFY_P50_CEILING_MS = 150;
const P99_CEILING_MS = 250;
const P99_TARGET_MS = 50;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describe('password verify under 4 concurrent hashes', () => {
  it('p50 and p99 under their CI ceilings; p99 printed against the 50 ms target', async () => {
    expect(process.env['UV_THREADPOOL_SIZE']).toBe('16');
    const hasher = createPasswordHasher({
      params: ARGON2_FLOOR,
      concurrency: CONCURRENT,
      queueMax: 64,
    });
    const stored = await hasher.hash('a long and quiet sentence');
    const times: number[] = [];
    const worker = async () => {
      while (times.length < SAMPLES) {
        const started = performance.now();
        await hasher.verify(stored, 'a long and quiet sentence');
        times.push(performance.now() - started);
      }
    };
    // Warm up, then measure with exactly 4 in flight.
    await Promise.all(Array.from({ length: CONCURRENT }, () => hasher.verify(stored, 'warm up')));
    await Promise.all(Array.from({ length: CONCURRENT }, worker));
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    console.info(
      `password verify at m=19456,t=2,p=1 with ${String(CONCURRENT)} in flight: ${String(sorted.length)} samples, p50 ${p50.toFixed(2)} ms (CI ceiling ${String(VERIFY_P50_CEILING_MS)}), p99 ${p99.toFixed(2)} ms (CI ceiling ${String(P99_CEILING_MS)}; target ${String(P99_TARGET_MS)} on quiet hardware), max ${(sorted.at(-1) ?? NaN).toFixed(2)} ms`,
    );
    expect(p50).toBeLessThanOrEqual(VERIFY_P50_CEILING_MS);
    expect(p99).toBeLessThanOrEqual(P99_CEILING_MS);
  });
});
