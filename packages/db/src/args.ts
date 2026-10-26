import { MigrateError } from './outcome.ts';

export type MigrateCommand =
  | { readonly command: 'up'; readonly migrationsDir: string | undefined }
  | { readonly command: 'down'; readonly count: number; readonly migrationsDir: string | undefined }
  | { readonly command: 'status'; readonly migrationsDir: string | undefined };

export const USAGE = 'usage: drefyn migrate up | down [n] | status [--migrations-dir <dir>]';

function refuse(why: string): never {
  throw new MigrateError('failed', `${why}\n${USAGE}`);
}

// argv after the program name: migrate up | down [n] | status [--migrations-dir <dir>].
// Throws MigrateError('failed') with the usage line.
export function parseMigrateArgs(argv: readonly string[]): MigrateCommand {
  const positional: string[] = [];
  let migrationsDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--migrations-dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '') refuse('--migrations-dir needs a folder');
      if (migrationsDir !== undefined) refuse('--migrations-dir given twice');
      migrationsDir = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      refuse(`unknown option ${JSON.stringify(arg)}`);
    } else {
      positional.push(arg);
    }
  }
  const [program, command, ...rest] = positional;
  if (program !== 'migrate') refuse('expected the migrate command');
  if (command === 'up' || command === 'status') {
    if (rest.length > 0) refuse(`${command} takes no count`);
    return { command, migrationsDir };
  }
  if (command === 'down') {
    if (rest.length > 1) refuse('down takes at most one count');
    const raw = rest[0] ?? '1';
    // One spelling per number, so "01" and "1e2" are refused rather than guessed at.
    const count = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(count)) refuse('down takes a whole number of steps above zero');
    return { command, count, migrationsDir };
  }
  return refuse('expected up, down or status');
}
