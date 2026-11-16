import { DEFAULT_LIMITS } from '@drefyn/mdx';
import { UNDECLARED_FILTER_MAX_ITEMS } from '@drefyn/schema';
import { z } from 'zod';

export interface EngineConfig {
  // Source bytes of one node. The host sizes its request limit from the same default, so this
  // can only come down.
  readonly maxNodeBytes: number;
  // Stored JSON of one tree, in a version on every save, and in head_content outside docs pages.
  readonly maxTreeBytes: number;
  // Close a chunk before it passes this.
  readonly chunkTargetChars: number;
  // No chunk passes this, whatever the page holds.
  readonly chunkMaxChars: number;
  // statement_timeout for a list. The app pool's own ceiling is 60 s.
  readonly queryTimeoutMs: number;
  // Lists one organization may run at once in this process, as this process's pool is what they
  // share. Protects the pool and is not something a plan sells, so it is not an entitlement.
  readonly queryMaxInFlight: number;
  // Lists and writes that may hold a connection at once in this process. Protects the pool, so
  // this is config too. Unset, it comes from the pool. Set, it must stay below
  // DREFYN_DATABASE_POOL_MAX, or a stall can take every connection and reads with it.
  readonly poolCeiling: number | undefined;
  // Writes that may wait for a place in this process.
  readonly poolQueue: number;
  // How long a gated transaction may keep its connection and its place, hung socket or not.
  readonly slotHoldMs: number;
  // The largest type an undeclared filter may read in full.
  readonly undeclaredScanMaxItems: number;
}

// A tree costs about 4 times its source at the corpus median and 7.5 at worst. 5 MiB keeps a
// full 1 MiB page of ordinary prose, a 700 KB page at the worst real ratio, and refuses the 85
// times growth that one character blocks reach.
const MAX_TREE_BYTES = 5_242_880;
const TREE_BYTES_CEILING = 16_777_216;

const CHUNK_TARGET_CHARS = 800;
// The corpus has a 10,074 character code block, so the cap has to be able to split one.
const CHUNK_MAX_CHARS = 2000;
const MIN_CHUNK_CHARS = 16;
const CHUNK_CHARS_CEILING = 200_000;

const QUERY_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_CEILING_MS = 60_000;
// Under half of the default pool of 10, so one organization alone leaves room for the rest.
// Several busy ones can still fill the pool: this is fairness, not a process ceiling.
const QUERY_MAX_IN_FLIGHT = 4;
const QUERY_IN_FLIGHT_CEILING = 256;
const POOL_CEILING_MAX = 1024;
// One organization alone reaches half of this: the 32 a project could queue before.
const POOL_QUEUE = 64;
const POOL_QUEUE_MAX = 4096;
// Past the 10 s an honest list of five statements can take at the default timeout.
const SLOT_HOLD_MS = 15_000;
const SLOT_HOLD_MAX_MS = 300_000;
const LIST_STATEMENTS = 5;
// Above the default the guarantee no longer holds, so a larger value is a choice and has a roof.
const SCAN_ITEMS_CEILING = 1_000_000;

const whole = (fallback: number, ceiling: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number)
    .pipe(z.int().min(1).max(ceiling));

const chars = (fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number)
    .pipe(z.int().min(MIN_CHUNK_CHARS).max(CHUNK_CHARS_CEILING));

const envSchema = z
  .object({
    DREFYN_ENGINE_MAX_NODE_BYTES: whole(DEFAULT_LIMITS.maxBytes, DEFAULT_LIMITS.maxBytes),
    DREFYN_ENGINE_MAX_TREE_BYTES: whole(MAX_TREE_BYTES, TREE_BYTES_CEILING),
    DREFYN_CHUNK_TARGET_CHARS: chars(CHUNK_TARGET_CHARS),
    DREFYN_CHUNK_MAX_CHARS: chars(CHUNK_MAX_CHARS),
    DREFYN_ENGINE_QUERY_TIMEOUT_MS: whole(QUERY_TIMEOUT_MS, QUERY_TIMEOUT_CEILING_MS),
    DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT: whole(QUERY_MAX_IN_FLIGHT, QUERY_IN_FLIGHT_CEILING),
    DREFYN_ENGINE_POOL_CEILING: z
      .string()
      .regex(/^[0-9]{1,9}$/)
      .transform(Number)
      .pipe(z.int().min(1).max(POOL_CEILING_MAX))
      .optional(),
    DREFYN_ENGINE_POOL_QUEUE: whole(POOL_QUEUE, POOL_QUEUE_MAX),
    DREFYN_ENGINE_SLOT_HOLD_MS: whole(SLOT_HOLD_MS, SLOT_HOLD_MAX_MS),
    DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS: whole(UNDECLARED_FILTER_MAX_ITEMS, SCAN_ITEMS_CEILING),
  })
  .refine((env) => env.DREFYN_CHUNK_TARGET_CHARS <= env.DREFYN_CHUNK_MAX_CHARS, {
    path: ['DREFYN_CHUNK_TARGET_CHARS'],
    message: 'must not pass DREFYN_CHUNK_MAX_CHARS',
  })
  .refine(
    (env) => env.DREFYN_ENGINE_SLOT_HOLD_MS >= LIST_STATEMENTS * env.DREFYN_ENGINE_QUERY_TIMEOUT_MS,
    {
      path: ['DREFYN_ENGINE_SLOT_HOLD_MS'],
      message: 'must cover five statements at DREFYN_ENGINE_QUERY_TIMEOUT_MS',
    },
  );

export function parseEngineConfig(env: Readonly<Record<string, string | undefined>>): EngineConfig {
  const parsed = envSchema.parse(env);
  return {
    maxNodeBytes: parsed.DREFYN_ENGINE_MAX_NODE_BYTES,
    maxTreeBytes: parsed.DREFYN_ENGINE_MAX_TREE_BYTES,
    chunkTargetChars: parsed.DREFYN_CHUNK_TARGET_CHARS,
    chunkMaxChars: parsed.DREFYN_CHUNK_MAX_CHARS,
    queryTimeoutMs: parsed.DREFYN_ENGINE_QUERY_TIMEOUT_MS,
    queryMaxInFlight: parsed.DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT,
    poolCeiling: parsed.DREFYN_ENGINE_POOL_CEILING,
    poolQueue: parsed.DREFYN_ENGINE_POOL_QUEUE,
    slotHoldMs: parsed.DREFYN_ENGINE_SLOT_HOLD_MS,
    undeclaredScanMaxItems: parsed.DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS,
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = parseEngineConfig({});
