// Times the two verify paths a sign in runs after the first factor: open the sealed TOTP
// secret and match a code, and match a recovery code against a full set of ten rows. Both
// must stay under 1 ms at p99, so the factor never becomes the slow part of signing in.
//   node packages/auth/bench/second-factor.ts [iterations]
// Exits 1 when either p99 is over budget, so a CI step can run it as is.
import { performance } from 'node:perf_hooks';
import { userId } from '@drefyn/tenancy';
import {
  aesGcmSealer,
  matchRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  totpCode,
} from '../src/index.ts';

const iterations = Number(process.argv[2] ?? 20_000);
const WARMUP = 2000;
const BUDGET_MS = 1;

const user = userId('01890a5d-ac96-774b-bcce-b302099a8057');
const sealer = aesGcmSealer([{ id: 'k1', material: new Uint8Array(32).fill(7) }]);
const secret = newTotpSecret();
const row = sealer.seal(secret, { userId: user });
const step = Math.floor(Date.now() / 30_000);
const codes = newRecoveryCodes(user);
const rows = codes.map((c, i) => ({ id: String(i), codeHash: c.hash }));
// The last row matches, the worst case for a loop that might exit early.
const typed = codes[codes.length - 1]?.code ?? '';
const rightTotp = totpCode(secret, step);
const wrongTotp = String((Number(rightTotp) + 1) % 1_000_000).padStart(6, '0');

function measure(name: string, work: (i: number) => void): number {
  for (let i = 0; i < WARMUP; i += 1) work(i);
  const times = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    work(i);
    times[i] = performance.now() - start;
  }
  times.sort();
  const at = (q: number) => times[Math.min(iterations - 1, Math.floor(q * iterations))] ?? 0;
  const p99 = at(0.99);
  const us = (ms: number) => `${(ms * 1000).toFixed(1)} us`;
  console.log(`${name}: p50 ${us(at(0.5))}, p99 ${us(p99)}, max ${us(at(1))}`);
  return p99;
}

const totp = measure('open and matchTotp', (i) => {
  const plain = sealer.open(row, { userId: user });
  // Half right and half wrong, so both outcomes are in the sample.
  matchTotp(plain, i % 2 === 0 ? rightTotp : wrongTotp, step);
});
const recovery = measure('matchRecoveryCode over 10 rows', (i) => {
  matchRecoveryCode(user, i % 2 === 0 ? typed : 'zzzzzz-zzzzzz-zzzzzz-zzzzzz', rows);
});

const over = [totp, recovery].some((p99) => p99 >= BUDGET_MS);
console.log(over ? `over budget: p99 must stay under ${BUDGET_MS} ms` : 'within budget');
process.exitCode = over ? 1 : 0;
