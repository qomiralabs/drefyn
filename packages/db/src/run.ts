import type { Env } from './config.ts';
import { notImplemented } from './not-implemented.ts';

export interface Output {
  write(text: string): void;
}

export interface RunMigrateOptions {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdout: Output;
  readonly stderr: Output;
}

// Resolves to the process exit code; never throws.
export function runMigrate(options: RunMigrateOptions): Promise<number> {
  return notImplemented('runMigrate', options);
}
