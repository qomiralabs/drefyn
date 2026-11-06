import { DEFAULT_LIMITS } from '@drefyn/mdx';
import { z } from 'zod';

export interface EngineConfig {
  // Source bytes of one node. The host sizes its request limit from the same default, so this
  // can only come down.
  readonly maxNodeBytes: number;
  // Stored JSON of one tree, copied into a version and into head_content on every save.
  readonly maxTreeBytes: number;
  // Close a chunk before it passes this.
  readonly chunkTargetChars: number;
  // No chunk passes this, whatever the page holds.
  readonly chunkMaxChars: number;
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

const bytes = (fallback: number, ceiling: number) =>
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
    DREFYN_ENGINE_MAX_NODE_BYTES: bytes(DEFAULT_LIMITS.maxBytes, DEFAULT_LIMITS.maxBytes),
    DREFYN_ENGINE_MAX_TREE_BYTES: bytes(MAX_TREE_BYTES, TREE_BYTES_CEILING),
    DREFYN_CHUNK_TARGET_CHARS: chars(CHUNK_TARGET_CHARS),
    DREFYN_CHUNK_MAX_CHARS: chars(CHUNK_MAX_CHARS),
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
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = parseEngineConfig({});
