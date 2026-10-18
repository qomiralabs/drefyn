import { notImplemented } from './not-implemented.ts';

export type MigrateCommand =
  | { readonly command: 'up'; readonly migrationsDir: string | undefined }
  | { readonly command: 'down'; readonly count: number; readonly migrationsDir: string | undefined }
  | { readonly command: 'status'; readonly migrationsDir: string | undefined };

// argv after the program name: migrate up | down [n] | status [--migrations-dir <dir>].
// Throws MigrateError('failed') with the usage line.
export function parseMigrateArgs(argv: readonly string[]): MigrateCommand {
  return notImplemented('parseMigrateArgs', argv);
}
