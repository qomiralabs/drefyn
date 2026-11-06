import { DEFAULT_LIMITS } from '@drefyn/mdx';
import { z } from 'zod';

export interface EngineConfig {
  // Source bytes of one node. The host sizes its request limit from the same default, so this
  // can only come down.
  readonly maxNodeBytes: number;
  // Stored JSON of one tree, copied into a version and into head_content on every save.
  readonly maxTreeBytes: number;
}

// A tree costs about 4 times its source at the corpus median and 7.5 at worst. 5 MiB keeps a
// full 1 MiB page of ordinary prose, a 700 KB page at the worst real ratio, and refuses the 85
// times growth that one character blocks reach.
const MAX_TREE_BYTES = 5_242_880;
const TREE_BYTES_CEILING = 16_777_216;

const bytes = (fallback: number, ceiling: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .default(String(fallback))
    .transform(Number)
    .pipe(z.int().min(1).max(ceiling));

const envSchema = z.object({
  DREFYN_ENGINE_MAX_NODE_BYTES: bytes(DEFAULT_LIMITS.maxBytes, DEFAULT_LIMITS.maxBytes),
  DREFYN_ENGINE_MAX_TREE_BYTES: bytes(MAX_TREE_BYTES, TREE_BYTES_CEILING),
});

export function parseEngineConfig(env: Readonly<Record<string, string | undefined>>): EngineConfig {
  const parsed = envSchema.parse(env);
  return {
    maxNodeBytes: parsed.DREFYN_ENGINE_MAX_NODE_BYTES,
    maxTreeBytes: parsed.DREFYN_ENGINE_MAX_TREE_BYTES,
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = parseEngineConfig({});
