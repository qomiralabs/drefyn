import { ZodError } from 'zod';
import { parseEngineConfig } from './config.ts';
import { gateLimits } from './pool-gate.ts';

// Shaped like the database config errors, so a start check can name the key. The message is
// fixed text: a value never reaches a log through it.
export class EngineConfigError extends Error {
  readonly code = 'ENGINE_CONFIG_INVALID';
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`${key} ${reason}`);
    this.name = 'EngineConfigError';
    this.key = key;
  }
}

const CEILING = 'DREFYN_ENGINE_POOL_CEILING';

// For a host's start, connecting to nothing. The ceiling checked is the one a store would use,
// so a pool too small to leave a connection over stops here and not at the first request.
export function checkEngineConfig(
  env: Readonly<Record<string, string | undefined>>,
  poolMax: number,
): void {
  let ceiling: number;
  try {
    ceiling = gateLimits(parseEngineConfig(env), poolMax).ceiling;
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const key = String(error.issues[0]?.path[0] ?? 'DREFYN_ENGINE');
    throw new EngineConfigError(key, 'is invalid');
  }
  if (ceiling >= poolMax) {
    throw new EngineConfigError(CEILING, 'must stay below DREFYN_DATABASE_POOL_MAX');
  }
}
