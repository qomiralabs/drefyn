// Compiling a 50 type schema against its budget, p95 under 10 ms: a validator per type and the
// OpenAPI document, serialized. Runs above load 10 are void and say so.
//   node bench/compile.ts
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  asFieldId,
  asTypeId,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type TypeId,
} from '@drefyn/schema';
import { compileValidator, emitOpenApi } from '../src/index.ts';

const P95_MS = 10;
const VOID_LOAD = 10;
const SAMPLES = 500;
const WARM_UP = 50;

const uuid = (kind: string, n: number) =>
  `00000000-0000-7000-${kind}-${n.toString(16).padStart(12, '0')}`;

function fieldId(n: number): FieldId {
  const id = asFieldId(uuid('8000', n));
  if (id === undefined) throw new Error('bad bench id');
  return id;
}

function typeId(n: number): TypeId {
  const id = asTypeId(uuid('9000', n));
  if (id === undefined) throw new Error('bad bench id');
  return id;
}

// 20 fields per type, 4 of them references, the shape the budget was measured on.
function field(t: number, f: number): FieldDef {
  const base = {
    id: fieldId(t * 100 + f + 1),
    apiName: `field${String(f)}`,
    label: `Field ${String(f)}`,
    required: f % 4 === 0,
  };
  switch (f % 5) {
    case 0:
      return { ...base, kind: 'reference', to: [typeId(((t + 1) % 50) + 1)], many: f % 2 === 0 };
    case 1:
      return { ...base, kind: 'number', scale: 2, filterable: true };
    case 2:
      return { ...base, kind: 'date', withTime: true };
    case 3:
      return f === 3 ? { ...base, kind: 'rich_text' } : { ...base, kind: 'boolean' };
    default:
      return { ...base, kind: 'text', maxLength: 200 };
  }
}

const TYPES: ContentSchema[] = Array.from({ length: 50 }, (_, t) => ({
  typeId: typeId(t + 1),
  apiName: `type${String(t)}`,
  version: 1,
  fields: Array.from({ length: 20 }, (_, f) => field(t, f)),
  deprecated: [fieldId(t * 100 + 2)],
  retired: [],
}));

const OPTIONS = { serverUrl: 'https://api.example.test', title: 'Bench', schemaVersion: 1 };

function compileOnce(): number {
  const start = performance.now();
  for (const type of TYPES) compileValidator(type);
  JSON.stringify(emitOpenApi(TYPES, OPTIONS));
  return performance.now() - start;
}

for (let i = 0; i < WARM_UP; i += 1) compileOnce();
const times = Array.from({ length: SAMPLES }, compileOnce).sort((a, b) => a - b);
const at = (fraction: number) =>
  times[Math.min(times.length - 1, Math.floor(times.length * fraction))] ?? 0;
const p50 = at(0.5);
const p95 = at(0.95);
const load = loadavg()[0] ?? 0;
console.log(
  `compile 50 types: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, budget ${String(P95_MS)} ms, load ${load.toFixed(1)}`,
);
if (load > VOID_LOAD) {
  console.log(`void: load above ${String(VOID_LOAD)}`);
} else if (p95 >= P95_MS) {
  process.exitCode = 1;
}
