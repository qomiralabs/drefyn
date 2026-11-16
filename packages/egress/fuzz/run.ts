// Run: pnpm --filter @drefyn/egress test:fuzz. The defaults are the CI run.
import { parseArgs } from 'node:util';
import { fuzz } from './target.ts';

const { values } = parseArgs({
  options: { seconds: { type: 'string', default: '60' }, seed: { type: 'string' } },
});

function wholeNumber(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(`--${name} must be a whole number`);
  return value;
}

const seconds = wholeNumber(values.seconds, 'seconds');
// A fresh seed each run covers new ground; it is printed so a failure can be replayed.
const seed = wholeNumber(values.seed ?? String(Date.now() % 2 ** 31), 'seed');

const report = fuzz({ seconds, seed });
console.log(
  `egress fuzz: ${String(report.runs)} runs in ${String(seconds)} s, seed ${String(seed)}`,
);
if (report.failure !== undefined) {
  console.error(`egress fuzz: failed: ${report.failure}`);
  process.exitCode = 1;
} else {
  console.log('egress fuzz: no address or URL the guard and the oracle disagree on');
}
