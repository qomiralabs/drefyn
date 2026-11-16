// The GraphQL budgets on a 50 type project of 20 fields each: emitting the schema, p95 under
// 10 ms; heap per cached schema, under 2 MB; and the cost of running a query beyond its
// resolvers, p99 under 1 ms. The resolvers here answer from memory at once, so a run's time
// is all overhead. Runs above load 10 are void and say so.
//   node --expose-gc bench/graphql.ts
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { organizationId, projectId } from '@drefyn/tenancy';
import type { GraphQLSchema } from 'graphql';
import {
  graphqlEmitter,
  runGraphql,
  type ContentItem,
  type GraphqlContext,
  type ResolverSet,
} from '../src/index.ts';
import { TYPES } from './fixtures.ts';

const EMIT_P95_MS = 10;
const HEAP_MB = 2;
const RUN_P99_MS = 1;
const VOID_LOAD = 10;
const CACHED = 20;

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error('run with node --expose-gc');

const id = (n: number) => `00000000-0000-7000-a000-${n.toString(16).padStart(12, '0')}`;
const first = TYPES[0];
if (first === undefined) throw new Error('no bench types');

// One page of 20 items with every scalar field filled.
const ITEMS: ContentItem[] = Array.from({ length: 20 }, (_, n) => ({
  id: id(n),
  versionId: id(1000 + n),
  typeId: first.typeId,
  fields: Object.fromEntries(
    first.fields.map((field): [string, string | boolean] => {
      switch (field.kind) {
        case 'number':
          return [field.id, '12.50'];
        case 'date':
          return [field.id, '2026-01-01T00:00:00.000Z'];
        case 'boolean':
          return [field.id, true];
        default:
          return [field.id, 'text'];
      }
    }),
  ),
}));

const page = Promise.resolve({ items: ITEMS, nextCursor: null });
const resolvers: ResolverSet = {
  list: () => page,
  get: () => Promise.resolve(ITEMS[0] ?? null),
  load: (_context, ids) => Promise.resolve(ids.map(() => null)),
  create: () => Promise.reject(new Error('read only bench')),
  update: () => Promise.reject(new Error('read only bench')),
  delete: () => Promise.reject(new Error('read only bench')),
};

const CONTEXT: GraphqlContext = {
  tenant: {
    organizationId: organizationId('0190a7b0-0000-7000-8000-000000000001'),
    projectId: projectId('0190a7b0-0000-7000-8000-000000000002'),
  },
};

const percentile = (times: number[], fraction: number) => {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

function timeEmit(): number {
  const start = performance.now();
  graphqlEmitter.emit(TYPES, resolvers);
  return performance.now() - start;
}

for (let i = 0; i < 30; i += 1) timeEmit();
const emitTimes = Array.from({ length: 300 }, timeEmit);
const emitP50 = percentile(emitTimes, 0.5);
const emitP95 = percentile(emitTimes, 0.95);

gc();
const before = process.memoryUsage().heapUsed;
const held = Array.from({ length: CACHED }, () => graphqlEmitter.emit(TYPES, resolvers));
gc();
const perSchemaMb = (process.memoryUsage().heapUsed - before) / CACHED / 1_048_576;

const cached = held[0];
if (cached === undefined) throw new Error('no schema');
const schema: GraphQLSchema = cached;
const QUERY = `{ list_${first.apiName}(limit: 20) { nextCursor items { id versionId fields {
  field1 field2 field3 field4 field6 field7 field8 field9 } } } }`;
async function timeRun(): Promise<number> {
  const start = performance.now();
  const result = await runGraphql(schema, { query: QUERY }, CONTEXT, {
    introspection: false,
  });
  const elapsed = performance.now() - start;
  if (result.errors !== undefined) throw new Error(`bench query failed: ${JSON.stringify(result)}`);
  return elapsed;
}

for (let i = 0; i < 300; i += 1) await timeRun();
const runTimes: number[] = [];
for (let i = 0; i < 3_000; i += 1) runTimes.push(await timeRun());
const runP50 = percentile(runTimes, 0.5);
const runP99 = percentile(runTimes, 0.99);

const load = loadavg()[0] ?? 0;
console.log(
  `graphql emit 50 types: p50 ${emitP50.toFixed(2)} ms, p95 ${emitP95.toFixed(2)} ms, budget ${String(EMIT_P95_MS)} ms`,
);
console.log(
  `graphql heap per cached schema: ${perSchemaMb.toFixed(2)} MB over ${String(held.length)}, budget ${String(HEAP_MB)} MB`,
);
console.log(
  `graphql run beyond resolvers: p50 ${runP50.toFixed(3)} ms, p99 ${runP99.toFixed(3)} ms, budget ${String(RUN_P99_MS)} ms, load ${load.toFixed(1)}`,
);
// Heap does not depend on load, so it counts even on a busy machine.
if (perSchemaMb >= HEAP_MB) process.exitCode = 1;
if (load > VOID_LOAD) {
  console.log(`void: load above ${String(VOID_LOAD)}`);
} else if (emitP95 >= EMIT_P95_MS || runP99 >= RUN_P99_MS) {
  process.exitCode = 1;
}
