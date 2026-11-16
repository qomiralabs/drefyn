// Compiling a 50 type schema against its budget, p95 under 10 ms: a validator per type and the
// OpenAPI document, serialized. Runs above load 10 are void and say so.
//   node bench/compile.ts
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { compileValidator, emitOpenApi } from '../src/index.ts';
import { TYPES } from './fixtures.ts';

const P95_MS = 10;
const VOID_LOAD = 10;
const SAMPLES = 500;
const WARM_UP = 50;

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
