import { z } from 'zod';
import { DEFAULT_MAX_FILES } from './store.ts';

export interface GitSyncConfig {
  // Docs files in one bound folder. Over it the binding pauses with git.too_large.
  readonly maxFiles: number;
}

const MAX_FILES_CEILING = 100_000;

const schema = z.strictObject({
  DREFYN_GIT_SYNC_MAX_FILES: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/)
    .transform(Number)
    .pipe(z.number().max(MAX_FILES_CEILING))
    .optional(),
});

export type GitSyncConfigErrorCode = 'git_sync.config_invalid';

// Reads only its own keys from the environment, so nothing else in it can change the result.
export function parseGitSyncConfig(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; value: GitSyncConfig } | { ok: false; error: GitSyncConfigErrorCode } {
  const value = env['DREFYN_GIT_SYNC_MAX_FILES'];
  const parsed = schema.safeParse(
    value === undefined || value === '' ? {} : { DREFYN_GIT_SYNC_MAX_FILES: value },
  );
  if (!parsed.success) return { ok: false, error: 'git_sync.config_invalid' };
  return {
    ok: true,
    value: { maxFiles: parsed.data.DREFYN_GIT_SYNC_MAX_FILES ?? DEFAULT_MAX_FILES },
  };
}
