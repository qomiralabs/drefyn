// Chunking alone, against its budget. Needs no stack:
//   node bench/chunk.ts
import { DEFAULT_LIMITS } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId } from '@drefyn/tenancy';
import { chunkNode, DEFAULT_ENGINE_CONFIG } from '../src/index.ts';
import { startHost } from '../test/support/parse-host.ts';
import { pageOf, percentile, rounded } from './support.ts';

const BUDGET_MS = 30;
const PAGE_BYTES = 100 * 1024;
const WARM_UP = 200;
const SAMPLES = 1000;

const source = pageOf(PAGE_BYTES);
const running = await startHost();
const parsed = await createParseClient({ url: running.url }).parse({
  tenant: {
    organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8201'),
    projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8202'),
  },
  path: 'bench',
  source,
  dialect: 'md',
  policy: {
    version: 1,
    components: new Set<string>(),
    rawHtml: 'sanitize',
    remoteImages: 'proxy',
    linkProtocols: ['https', 'http', 'mailto'],
    limits: DEFAULT_LIMITS,
  },
});
running.host.kill('SIGKILL');
if (!parsed.ok) throw new Error(`refused: ${parsed.error.map((e) => e.code).join(' ')}`);
const root = parsed.value.ast;
const options = {
  targetChars: DEFAULT_ENGINE_CONFIG.chunkTargetChars,
  maxChars: DEFAULT_ENGINE_CONFIG.chunkMaxChars,
};

const samples: number[] = [];
let chunks = 0;
for (let round = 0; round < WARM_UP + SAMPLES; round += 1) {
  const started = performance.now();
  chunks = chunkNode(root, options).length;
  if (round >= WARM_UP) samples.push(performance.now() - started);
}
const p99 = percentile(samples, 0.99);
const line = {
  case: 'chunk 100 KB',
  source_bytes: Buffer.byteLength(source),
  chunks,
  samples: samples.length,
  p50_ms: rounded(percentile(samples, 0.5)),
  p99_ms: rounded(p99),
  budget_ms: BUDGET_MS,
};
process.stdout.write(`${JSON.stringify(line)}\n`);
process.exitCode = p99 < BUDGET_MS ? 0 : 1;
