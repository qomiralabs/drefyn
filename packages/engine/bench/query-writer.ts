// The write load for bench/query.ts, on its own thread so saves do not add to list times. Opens
// one save every interval and does not wait for it, as clients would, so a slow save cannot slow
// the load down and hide itself. The parse host is left out: it runs in another process, and one
// project's parse budget would stop it near 12 saves a second long before Postgres is the limit.
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { closeDatabase, createDatabase, parseDatabaseConfig } from '@drefyn/db';
import type { MdxRoot } from '@drefyn/mdx';
import type { TenantRef } from '@drefyn/tenancy';
import {
  createEngine,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type EngineDeps,
  type NodeId,
  type VersionId,
} from '../src/index.ts';
import { benchValues, percentile, rounded, type BenchFields } from './support.ts';

export interface WriterInput {
  readonly url: string;
  readonly tenant: TenantRef;
  readonly nodes: readonly (readonly [string, string])[];
  readonly fields: BenchFields;
  readonly small: { readonly content: MdxRoot; readonly text: string };
  readonly large: { readonly content: MdxRoot; readonly text: string };
  readonly savesPerSecond: number;
  readonly slotChangeShare: number;
  readonly seconds: number;
}

// A limit on open saves, so a stalled database shows up as dropped saves, not a growing queue.
const MAX_OPEN = 32;
const LARGE_SHARE = 0.1;

const input = workerData as WriterInput;
const db = await createDatabase(
  parseDatabaseConfig({
    DREFYN_DATABASE_URL: input.url,
    DREFYN_DATABASE_SSL: 'disable',
    DREFYN_DATABASE_POOL_MAX: String(MAX_OPEN),
  }),
);
const texts = new Map([
  [input.small.content, input.small.text],
  [input.large.content, input.large.text],
]);
const heads = new Map(input.nodes.map(([node, version]) => [node, version]));
const ids = input.nodes.map(([node]) => node);

const parse = {
  print: (request: { readonly root: MdxRoot }) => {
    const text = [...texts.values()].find(
      (candidate) => candidate.length === sourceLength(request.root),
    );
    return Promise.resolve({ ok: true, value: { ast: request.root, text } });
  },
} as unknown as EngineDeps['parse'];

function sourceLength(root: MdxRoot): number {
  return (
    root.children.reduce(
      (sum, { source }) => sum + (source?.gapBefore ?? '').length + (source?.raw ?? '').length,
      0,
    ) + root.tail.length
  );
}

const engine = createEngine({
  store: databaseStore(db, DEFAULT_ENGINE_CONFIG),
  parse,
  parsePolicy: {
    version: 1,
    components: [],
    rawHtml: 'sanitize',
    remoteImages: 'proxy',
    linkProtocols: ['https', 'http', 'mailto'],
  },
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});

let open = 0;
let done = 0;
let dropped = 0;
let failed = 0;
let conflicts = 0;
let round = 0;
const times: number[] = [];

async function saveOne(): Promise<void> {
  round += 1;
  const nodeId = ids[Math.floor(Math.random() * ids.length)] ?? '';
  const page = Math.random() < LARGE_SHARE ? input.large : input.small;
  const changes = Math.random() < input.slotChangeShare;
  const started = performance.now();
  const saved = await engine.saveDraft({
    tenant: input.tenant,
    nodeId: nodeId as NodeId,
    expectedHeadVersionId: (heads.get(nodeId) ?? null) as VersionId | null,
    content: page.content,
    origin: 'human',
    actor: { kind: 'system', job: 'bench' },
    idempotencyKey: randomUUID(),
    ...(changes ? { fields: benchValues(input.fields, round) } : {}),
  });
  if (saved.ok) {
    done += 1;
    heads.set(nodeId, saved.value.versionId);
    times.push(performance.now() - started);
  } else if (saved.error.code === 'engine.version_conflict') conflicts += 1;
  else failed += 1;
}

const interval = 1000 / input.savesPerSecond;
const started = performance.now();
const total = Math.floor(input.seconds * input.savesPerSecond);
for (let turn = 0; turn < total; turn += 1) {
  const due = started + turn * interval;
  const wait = due - performance.now();
  if (wait > 0) await pause(wait);
  if (open >= MAX_OPEN) {
    dropped += 1;
    continue;
  }
  open += 1;
  void saveOne()
    .catch(() => {
      failed += 1;
    })
    .finally(() => {
      open -= 1;
    });
}
while (open > 0) await pause(20);
await closeDatabase(db);

parentPort?.postMessage({
  saves: done,
  per_second: rounded(done / ((performance.now() - started) / 1000)),
  dropped,
  failed,
  conflicts,
  save_p50_ms: rounded(percentile(times, 0.5)),
  save_p95_ms: rounded(percentile(times, 0.95)),
});
