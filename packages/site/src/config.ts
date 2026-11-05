import { z } from 'zod';
import type { Result } from './types.ts';

// Past this a first response no longer fits the first round trip.
export const HARD_FIRST_RESPONSE_BYTES = 16_000;
export const DEFAULT_FIRST_RESPONSE_BYTES = 14_000;

const CONFIG_KEY = 'DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES';

export interface SiteConfig {
  readonly maxFirstResponseBytes: number;
}

export interface SiteConfigError {
  readonly code: 'site.config_invalid';
  readonly key: typeof CONFIG_KEY;
}

const bytes = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.int().max(HARD_FIRST_RESPONSE_BYTES));

export function loadSiteConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<SiteConfig, SiteConfigError> {
  const raw = env[CONFIG_KEY];
  if (raw === undefined) {
    return { ok: true, value: { maxFirstResponseBytes: DEFAULT_FIRST_RESPONSE_BYTES } };
  }
  const parsed = bytes.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: { code: 'site.config_invalid', key: CONFIG_KEY } };
  return { ok: true, value: { maxFirstResponseBytes: parsed.data } };
}
