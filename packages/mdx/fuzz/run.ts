// Run: pnpm --filter @drefyn/mdx test:fuzz. The defaults are the CI run.
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fuzz } from './target.ts';

const { values } = parseArgs({
  options: { seconds: { type: 'string', default: '60' }, seed: { type: 'string' } },
});
const seconds = z.coerce.number().int().positive().parse(values.seconds);
// A fresh seed each run covers new ground; it is printed so a failure can be replayed.
const seed = z.coerce
  .number()
  .int()
  .parse(values.seed ?? Date.now() % 2 ** 31);

const report = fuzz({ seconds, seed });
console.log(`mdx fuzz: ${report.runs} runs in ${seconds} s, seed ${seed}`);
if (report.failure !== undefined) {
  console.error(`mdx fuzz: failed: ${report.failure}`);
  process.exitCode = 1;
} else {
  console.log('mdx fuzz: no crash');
}
