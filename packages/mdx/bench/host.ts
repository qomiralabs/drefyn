// What a warm 6 KB page costs through the real host under --permission, against a parse in this
// process, so the difference is what the hop adds. pnpm --filter @drefyn/mdx bench:host
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createParseClient } from '../src/client.ts';
import { parseForStore } from '../src/parse.ts';
import {
  CLIENT,
  HOST_TOKEN_SHA256,
  isolatedPolicy,
  loadCorpus,
  ORG_A,
  PROJECT_A,
} from '../test/helpers.ts';

const TARGET_BYTES = 6_144;
const SAMPLES = 300;
const WARM_UP = 60;
const BUDGET_MS = 15;

const page = [...loadCorpus()].sort(
  (one, two) =>
    Math.abs(one.bytes.length - TARGET_BYTES) - Math.abs(two.bytes.length - TARGET_BYTES),
)[0];
if (page === undefined) throw new Error('the corpus is empty');

const workspace = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const host = spawn(
  process.execPath,
  [
    '--permission',
    `--allow-fs-read=${workspace}`,
    '--allow-worker',
    fileURLToPath(new URL('../src/host-main.ts', import.meta.url)),
  ],
  {
    env: { DREFYN_PARSE_PORT: '0', DREFYN_PARSE_TOKEN_SHA256: HOST_TOKEN_SHA256 },
    stdio: ['ignore', 'pipe', 'ignore'],
  },
);
const [first] = (await once(host.stdout, 'data')) as [Buffer];
const port = /"port":(\d+)/.exec(first.toString())?.[1] ?? '';
const client = createParseClient({ ...CLIENT, url: `http://127.0.0.1:${port}` });
const policy = isolatedPolicy();
const request = {
  tenant: { organizationId: ORG_A, projectId: PROJECT_A },
  path: 'bench/page.md',
  source: page.text,
  dialect: page.dialect,
  policy,
};

const percentile = (samples: readonly number[], share: number) =>
  [...samples].sort((one, two) => one - two)[Math.floor(samples.length * share)] ?? 0;

async function timed(run: () => unknown): Promise<readonly number[]> {
  const samples: number[] = [];
  for (let index = 0; index < WARM_UP + SAMPLES; index += 1) {
    const began = performance.now();
    await run();
    if (index >= WARM_UP) samples.push(performance.now() - began);
  }
  return samples;
}

const direct = await timed(() => parseForStore(page.text, page.dialect, policy));
const parsed = await timed(async () => {
  const result = await client.parse(request);
  if (!result.ok) throw new Error('refused');
});
const answer = await client.parse(request);
if (!answer.ok) throw new Error('refused');
const { tenant, path } = request;
const printed = await timed(async () => {
  const result = await client.print({ tenant, path, policy, root: answer.value.ast });
  if (!result.ok) throw new Error('refused');
});
host.kill('SIGKILL');

const row = (name: string, samples: readonly number[]) => {
  console.log(
    `${name.padEnd(22)} p50 ${percentile(samples, 0.5).toFixed(2)} ms, p95 ${percentile(samples, 0.95).toFixed(2)} ms`,
  );
};
console.log(
  `${page.file}, ${String(page.bytes.length)} bytes, load ${loadavg()[0]?.toFixed(1) ?? '?'}`,
);
row('in this process', direct);
row('parse through the host', parsed);
row('print through the host', printed);
const added = percentile(parsed, 0.95) - percentile(direct, 0.95);
console.log(`added at p95: ${added.toFixed(2)} ms, budget ${String(BUDGET_MS)} ms`);
process.exit(0);
