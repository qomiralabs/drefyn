import { z } from 'zod';

export interface SchemaCacheConfig {
  // Estimated bytes of compiled schemas this process keeps.
  readonly maxBytes: number;
}

// About 600 cached 50 type projects at the measured 427 KB each.
const DEFAULT_MAX_BYTES = 268_435_456;
const MAX_BYTES_CEILING = 68_719_476_736;

const envSchema = z.object({
  DREFYN_SCHEMA_CACHE_MAX_BYTES: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .default(String(DEFAULT_MAX_BYTES))
    .transform(Number)
    .pipe(z.int().min(1).max(MAX_BYTES_CEILING)),
});

export function parseSchemaCacheConfig(
  env: Readonly<Record<string, string | undefined>>,
): SchemaCacheConfig {
  return { maxBytes: envSchema.parse(env).DREFYN_SCHEMA_CACHE_MAX_BYTES };
}
