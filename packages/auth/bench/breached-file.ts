// Builds a breached list of N records through the real build path, then times lookups in
// it and samples RSS, so the memory and latency claims are measured rather than assumed.
//   node packages/auth/bench/breached-file.ts [records] [lookups]
// Needs about 70 bytes of free disk a record (the text input plus the list), in the temp
// folder. The list was just written, so lookups run against a warm page cache; a cold
// disk is slower, and the CI run is what counts.
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildPasswordList, openBreachedPasswordFile } from '../src/index.ts';

const records = Number(process.argv[2] ?? 50_000_000);
const lookups = Number(process.argv[3] ?? 20_000);
const SAMPLES = 10_000;
const LINES_PER_WRITE = 65_536;

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;
const rss = () => process.memoryUsage().rss;

// Strictly ascending by construction: the first four bytes grow with the index, which is
// unique while records stay under 2^32.
function recordAt(i: number): Buffer {
  const record = randomBytes(20);
  record.writeUInt32BE(Math.floor((i * 2 ** 32) / records), 0);
  return record;
}

const dir = await mkdtemp(join(tmpdir(), 'drefyn-bench-breached-'));
try {
  const from = join(dir, 'pwned.txt');
  const out = join(dir, 'breached.bin');
  const hits: Buffer[] = [];
  const every = Math.max(1, Math.floor(records / SAMPLES));
  const input = await open(from, 'w');
  for (let start = 0; start < records; start += LINES_PER_WRITE) {
    const lines: string[] = [];
    for (let i = start; i < Math.min(records, start + LINES_PER_WRITE); i += 1) {
      const record = recordAt(i);
      if (i % every === 0) hits.push(record);
      lines.push(`${record.toString('hex').toUpperCase()}:${String(1 + (i % 50))}\r\n`);
    }
    await input.write(lines.join(''));
  }
  await input.close();

  const beforeBuild = rss();
  let buildPeak = beforeBuild;
  const sampler = setInterval(() => {
    buildPeak = Math.max(buildPeak, rss());
  }, 50);
  const buildStart = performance.now();
  const summary = await buildPasswordList({ from, out, minCount: 1 });
  const buildSeconds = (performance.now() - buildStart) / 1000;
  clearInterval(sampler);
  await rm(from);
  const size = (await stat(out)).size;

  const file = await openBreachedPasswordFile(out);
  const beforeLookups = rss();
  let lookupPeak = beforeLookups;
  const times: number[] = [];
  let found = 0;
  for (let n = 0; n < lookups + 1_000; n += 1) {
    // Half known hits, half random misses.
    const query = n % 2 === 0 ? (hits[n % hits.length] ?? randomBytes(20)) : randomBytes(20);
    const started = performance.now();
    const answer = await file.contains(query);
    const took = performance.now() - started;
    // The first thousand warm up the JIT and are not counted.
    if (n >= 1_000) {
      times.push(took);
      if (answer === true) found += 1;
    }
    if (n % 1_000 === 0) lookupPeak = Math.max(lookupPeak, rss());
  }
  await file.close();
  times.sort((a, b) => a - b);
  const at = (q: number) =>
    (times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0).toFixed(3);

  console.log(`records ${String(summary.records)} (${mib(size)} on disk)`);
  console.log(
    `build ${buildSeconds.toFixed(1)} s, rss before ${mib(beforeBuild)}, peak ${mib(buildPeak)}`,
  );
  console.log(`lookups ${String(times.length)}, hits ${String(found)}`);
  console.log(`p50 ${at(0.5)} ms, p99 ${at(0.99)} ms, max ${at(1)} ms`);
  console.log(
    `rss before lookups ${mib(beforeLookups)}, peak during ${mib(lookupPeak)}, after ${mib(rss())}`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
