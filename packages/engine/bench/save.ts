// A whole saveDraft through the real parse host and Postgres, against the budget. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> pnpm --filter @drefyn/engine bench
// Plain Node, not vitest bench: its module runner adds to every call and it reports no p95.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig } from '@drefyn/db';
import { DEFAULT_LIMITS, type MdxRoot } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { createEngine, databaseStore, type NodeId, type VersionId } from '../src/index.ts';
import setup from '../test/support/global-setup.ts';
import { parseClientConfig } from '../test/support/parse-host.ts';
import { superuser, urlFor } from '../test/support/stack.ts';

const SAVE_BUDGET_MS = 150;
const SMALL_PAGE_BUDGET_MS = 25;
const LARGE_PAGE_BYTES = 100 * 1024;
const SMALL_PAGE_BYTES = 6 * 1024;
const WARM_UP = 30;
const SAMPLES = 120;
// Lets the garbage collector and the JIT threads settle, as a server between requests would.
const PAUSE_MS = 20;

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

// Real pages, smallest first, joined until they pass the size. md, since mdx pages share import
// names, and a repeated binding is a syntax error in one file.
function pageOf(bytes: number): string {
  const pages = readdirSync(corpus)
    .filter((file) => file.endsWith('.md.txt'))
    .sort()
    .map((file) => readFileSync(join(corpus, file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''))
    .sort((a, b) => a.length - b.length);
  let page = '';
  for (const text of pages) {
    page += `${text}\n\n`;
    if (Buffer.byteLength(page) >= bytes) return page;
  }
  throw new Error('the corpus is too small for this page');
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';
const parseUrl = provided.get('engineParseUrl') ?? '';

const organization = randomUUID();
const project = randomUUID();
const typeId = randomUUID();
await superuser(
  `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${organization}', 'Bench', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${organization}', 'docs', 'bench', 'Bench');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${organization}', '${project}', 'docs_page', 'page');`,
  name,
);
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const parse = createParseClient(parseClientConfig(parseUrl));
const parsePolicy = {
  version: 1,
  components: [] as string[],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
} as const;
const engine = createEngine({
  store: databaseStore(db),
  parse,
  parsePolicy,
  flags: { isOn: () => Promise.resolve(true) },
});

async function treeOf(source: string): Promise<MdxRoot> {
  const answer = await parse.parse({
    tenant,
    path: 'bench',
    source,
    dialect: 'md',
    policy: { ...parsePolicy, components: new Set(), limits: DEFAULT_LIMITS },
  });
  if (!answer.ok) throw new Error(`refused: ${answer.error.map((e) => e.code).join(' ')}`);
  return answer.value.ast;
}

async function run(label: string, source: string, budgetMs: number): Promise<boolean> {
  const content = await treeOf(source);
  const made = await engine.createNode({ tenant, family: 'docs_page', typeId });
  if (!made.ok) throw new Error(made.error.code);
  const nodeId: NodeId = made.value.nodeId;
  let head: VersionId | null = null;
  const samples: number[] = [];
  for (let round = 0; round < WARM_UP + SAMPLES; round += 1) {
    const started = performance.now();
    const saved = await engine.saveDraft({
      tenant,
      nodeId,
      expectedHeadVersionId: head,
      content,
      origin: 'human',
      actor: { kind: 'system', job: 'bench' },
      idempotencyKey: randomUUID(),
    });
    const elapsed = performance.now() - started;
    if (!saved.ok) throw new Error(saved.error.code);
    head = saved.value.versionId;
    if (round >= WARM_UP) samples.push(elapsed);
    await pause(PAUSE_MS);
  }
  const p95 = percentile(samples, 0.95);
  const line = {
    case: label,
    source_bytes: Buffer.byteLength(source),
    stored_bytes: Buffer.byteLength(JSON.stringify(content)),
    samples: samples.length,
    p50_ms: Number(percentile(samples, 0.5).toFixed(1)),
    p95_ms: Number(p95.toFixed(1)),
    p99_ms: Number(percentile(samples, 0.99).toFixed(1)),
    budget_ms: budgetMs,
    load: Number((loadavg()[0] ?? 0).toFixed(1)),
    cores: cpus().length,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return p95 < budgetMs;
}

let outcomes: readonly boolean[];
try {
  outcomes = [
    await run('save 100 KB', pageOf(LARGE_PAGE_BYTES), SAVE_BUDGET_MS),
    await run('save 6 KB', pageOf(SMALL_PAGE_BYTES), SMALL_PAGE_BUDGET_MS),
  ];
} finally {
  await closeDatabase(db);
  await teardown();
}
process.exitCode = outcomes.every(Boolean) ? 0 : 1;
