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
    DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS: whole(UNDECLARED_FILTER_MAX_ITEMS, SCAN_ITEMS_CEILING),
  })
  .refine((env) => env.DREFYN_CHUNK_TARGET_CHARS <= env.DREFYN_CHUNK_MAX_CHARS, {
    path: ['DREFYN_CHUNK_TARGET_CHARS'],
    message: 'must not pass DREFYN_CHUNK_MAX_CHARS',
  });

export function parseEngineConfig(env: Readonly<Record<string, string | undefined>>): EngineConfig {
  const parsed = envSchema.parse(env);
  return {
    maxNodeBytes: parsed.DREFYN_ENGINE_MAX_NODE_BYTES,
    maxTreeBytes: parsed.DREFYN_ENGINE_MAX_TREE_BYTES,
    chunkTargetChars: parsed.DREFYN_CHUNK_TARGET_CHARS,
    chunkMaxChars: parsed.DREFYN_CHUNK_MAX_CHARS,
    queryTimeoutMs: parsed.DREFYN_ENGINE_QUERY_TIMEOUT_MS,
    undeclaredScanMaxItems: parsed.DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS,
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = parseEngineConfig({});
