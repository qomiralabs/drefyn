import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { parseAuthDatabaseConfig } from '../src/config.ts';
import { databaseOverPool, poolConfig, type AuthDatabase } from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import { reserveAuthRateWindows } from '../src/rate-windows.ts';

// Floods one key through the pool the auth config builds, while unrelated keys arrive at a
// steady rate behind it, as one sign in each. Run through scripts/bench-limiter-flood.sh.

const WINDOWS = [600, 86_400];
const BUCKET = 'bench_flood';
const UNRELATED_EVERY_MS = 100;
// The timeout an unrelated sign in has to beat.
const RESERVE_TIMEOUT_MS = 1000;
const ALS_ROUNDS = 5_000_000;

interface Tally {
  readonly ms: number[];
  readonly failures: Map<string, number>;
}

const tally = (): Tally => ({ ms: [], failures: new Map() });

async function timed(into: Tally, attempt: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  try {
    await attempt();
    into.ms.push(performance.now() - start);
  } catch (error) {
    const code = error instanceof DbError ? error.code : 'OTHER';
    into.failures.set(code, (into.failures.get(code) ?? 0) + 1);
  }
}

function percentile(sorted: readonly number[], p: number): string {
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return value === undefined ? 'n/a' : value.toFixed(1);
}

function line(name: string, ms: readonly number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  return `${name}: n=${String(sorted.length)} p50=${percentile(sorted, 0.5)} p99=${percentile(sorted, 0.99)} max=${percentile(sorted, 1)} ms`;
}

const failed = (t: Tally) => JSON.stringify(Object.fromEntries(t.failures));

// Wraps connect, since the wait for a connection is what a flood stretches and no reservation
// can see it apart from its own round trip.
function timedPool(pool: pg.Pool, waits: number[]): pg.Pool {
  const connect = async () => {
    const start = performance.now();
    try {
      return await pool.connect();
    } finally {
      waits.push(performance.now() - start);
    }
  };
  return { connect } as unknown as pg.Pool;
}

async function flood(env: NodeJS.ProcessEnv, workers: number, seconds: number): Promise<void> {
  const config = parseAuthDatabaseConfig(env);
  const pool = new pg.Pool(poolConfig(config, 'auth'));
  pool.on('error', () => undefined);
  const waits: number[] = [];
  const db = databaseOverPool(timedPool(pool, waits), 'auth', {
    statementTimeoutMs: config.statementTimeoutMs,
  }) as AuthDatabase;
  const reserve = (keyHmac: Uint8Array) =>
    reserveAuthRateWindows(db, { bucket: BUCKET, keyHmac, windowSeconds: WINDOWS });

  const hotKey = randomBytes(32);
  const hot = tally();
  const unrelated = tally();
  const end = performance.now() + seconds * 1000;
  const worker = async () => {
    while (performance.now() < end) await timed(hot, () => reserve(hotKey));
  };
  const others: Promise<void>[] = [];
  const arrivals = setInterval(() => {
    others.push(timed(unrelated, () => reserve(randomBytes(32))));
  }, UNRELATED_EVERY_MS);
  await Promise.all(Array.from({ length: workers }, worker));
  clearInterval(arrivals);
  await Promise.all(others);
  await pool.end();

  const over = unrelated.ms.filter((ms) => ms >= RESERVE_TIMEOUT_MS).length;
  console.log(`flood workers=${String(workers)} pool=${String(config.poolMax)}`);
  console.log(`  ${line('hot key', hot.ms)} failures=${failed(hot)}`);
  console.log(`  ${line('pool wait', waits)}`);
  console.log(
    `  ${line('unrelated', unrelated.ms)} over_1s=${String(over)} failures=${failed(unrelated)}`,
  );
}

// What the guard adds: a run per guarded transaction and a read per reservation.
function storageCost(): void {
  const storage = new AsyncLocalStorage<{ held: boolean }>();
  const mark = { held: true };
  const measure = (round: () => boolean): number => {
    const start = performance.now();
    let held = 0;
    for (let i = 0; i < ALS_ROUNDS; i += 1) if (round()) held += 1;
    if (held < 0) throw new Error('unreachable');
    return ((performance.now() - start) * 1_000_000) / ALS_ROUNDS;
  };
  const read = () => storage.getStore()?.held === true;
  const base = measure(() => mark.held);
  const outside = measure(read);
  const inside = measure(() => storage.run(mark, read));
  console.log(
    `guard cost: read ${(outside - base).toFixed(1)} ns, run and read ${(inside - base).toFixed(1)} ns`,
  );
}

const [workers = '16,64,256,1024', seconds = '20'] = process.argv.slice(2);
for (const size of workers.split(',')) await flood(process.env, Number(size), Number(seconds));
storageCost();
