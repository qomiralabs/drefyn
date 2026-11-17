// Runs every bench in order, or only those named: `pnpm bench -- publish`. Names match whole,
// so publish does not also run published.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ALL = ['chunk', 'save', 'query', 'tree', 'published', 'publish'] as const;

const named = process.argv.slice(2).filter((arg) => arg !== '--');
const unknown = named.filter((arg) => !(ALL as readonly string[]).includes(arg));
if (unknown.length > 0) {
  process.stderr.write(`no bench named ${unknown.join(', ')}; known: ${ALL.join(', ')}\n`);
  process.exit(64);
}
const chosen = named.length === 0 ? ALL : ALL.filter((bench) => named.includes(bench));

for (const bench of chosen) {
  const done = spawnSync(process.execPath, [join(import.meta.dirname, `${bench}.ts`)], {
    stdio: 'inherit',
  });
  if (done.status !== 0) process.exit(done.status ?? 1);
}
