import { PasswordListError, buildPasswordList } from './password-list.ts';

export interface RunAuthCommandOptions {
  // After the program name, starting with "auth".
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

export const AUTH_COMMAND_USAGE =
  'usage: drefyn auth password-list build --from <file> --min-count <n> --out <file>';

const EXIT_DONE = 0;
const EXIT_BAD_INPUT = 2;
const EXIT_FILES = 5;

class UsageError extends Error {}

const OPTIONS = ['--from', '--min-count', '--out'] as const;
type Option = (typeof OPTIONS)[number];

function parseBuild(argv: readonly string[]) {
  const [program, group, command, ...rest] = argv;
  if (program !== 'auth' || group !== 'password-list' || command !== 'build') {
    throw new UsageError('expected auth password-list build');
  }
  const values = new Map<Option, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i] ?? '';
    const value = rest[i + 1];
    const option = OPTIONS.find((o) => o === name);
    if (option === undefined) throw new UsageError(`unknown argument ${JSON.stringify(name)}`);
    if (values.has(option)) throw new UsageError(`${option} given twice`);
    if (value === undefined || value === '') throw new UsageError(`${option} needs a value`);
    values.set(option, value);
  }
  const from = values.get('--from');
  const out = values.get('--out');
  const rawCount = values.get('--min-count');
  if (from === undefined || out === undefined || rawCount === undefined) {
    throw new UsageError('--from, --min-count and --out are all required');
  }
  // One spelling per number, so "01" and "1e3" are refused rather than guessed at.
  const minCount = /^[1-9][0-9]*$/.test(rawCount) ? Number(rawCount) : Number.NaN;
  if (!Number.isSafeInteger(minCount)) {
    throw new UsageError('--min-count takes a whole number of 1 or more');
  }
  return { from, out, minCount };
}

// The `drefyn auth` commands; returns the exit code. The list build reads no environment
// and opens no connection, so it runs on any machine with the downloaded file.
export async function runAuthCommand(options: RunAuthCommandOptions): Promise<number> {
  const { stdout, stderr } = options;
  let build: ReturnType<typeof parseBuild>;
  try {
    build = parseBuild(options.argv);
  } catch (error) {
    stderr.write(`password-list: ${(error as Error).message}\n${AUTH_COMMAND_USAGE}\n`);
    return EXIT_BAD_INPUT;
  }
  try {
    const summary = await buildPasswordList(build);
    stdout.write(
      `password-list: read ${String(summary.lines)} lines, wrote ${String(summary.records)} records to ${build.out}, dropped ${String(summary.belowMinCount)} under --min-count ${String(build.minCount)}\n`,
    );
    return EXIT_DONE;
  } catch (error) {
    // Only fixed messages and error codes reach the terminal; never a line of input.
    if (error instanceof PasswordListError) {
      stderr.write(`password-list: ${error.message}\n`);
      return error.kind === 'input' ? EXIT_BAD_INPUT : EXIT_FILES;
    }
    stderr.write('password-list: failed\n');
    return EXIT_FILES;
  }
}
