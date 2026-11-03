import {
  DbError,
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  type AuthDatabase,
  type Database,
} from '@drefyn/db';
import { checkCliLinkInput, createCliLinks } from './cli-links.ts';
import { parseAuthConfig, type AuthConfig, type Env } from './config.ts';
import { AuthError } from './errors.ts';
import { createOperatorSessions } from './operator-sessions.ts';
import { PasswordListError, buildPasswordList } from './password-list.ts';
import type { AuthLogger } from './rate-limiter.ts';

export interface RunAuthCommandOptions {
  // After the program name, starting with "auth".
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

export const AUTH_COMMAND_USAGE = [
  'usage: drefyn auth password-list build --from <file> --min-count <n> --out <file>',
  '       drefyn auth link --email <address> [--create-organization <name>]',
  '       drefyn auth revoke-sessions --email <address> | --all',
].join('\n');

const EXIT_DONE = 0;
const EXIT_BAD_INPUT = 2;
const EXIT_CONFIG = 3;
const EXIT_DATABASE = 4;
const EXIT_FILES = 5;

class UsageError extends Error {}

// --name value pairs and bare flags, each at most once, nothing else.
function parseOptions<const V extends string, const F extends string>(
  rest: readonly string[],
  valued: readonly V[],
  flags: readonly F[] = [],
): { values: Map<V, string>; flags: Set<F> } {
  const values = new Map<V, string>();
  const seen = new Set<F>();
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i] ?? '';
    const flag = flags.find((f) => f === name);
    if (flag !== undefined) {
      if (seen.has(flag)) throw new UsageError(`${flag} given twice`);
      seen.add(flag);
      continue;
    }
    const option = valued.find((o) => o === name);
    // Never echo the argument: it may be an address typed in the wrong place.
    if (option === undefined) throw new UsageError('unknown argument');
    if (values.has(option)) throw new UsageError(`${option} given twice`);
    const value = rest[i + 1];
    if (value === undefined || value === '') throw new UsageError(`${option} needs a value`);
    values.set(option, value);
    i += 1;
  }
  return { values, flags: seen };
}

function parseBuild(rest: readonly string[]) {
  const { values } = parseOptions(rest, ['--from', '--min-count', '--out']);
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

function parseLink(rest: readonly string[]) {
  const { values } = parseOptions(rest, ['--email', '--create-organization']);
  const email = values.get('--email');
  if (email === undefined) throw new UsageError('--email is required');
  const organizationName = values.get('--create-organization');
  return organizationName === undefined ? { email } : { email, organizationName };
}

function parseRevoke(rest: readonly string[]) {
  const { values, flags } = parseOptions(rest, ['--email'], ['--all']);
  const email = values.get('--email');
  if ((email === undefined) === !flags.has('--all')) {
    throw new UsageError('give either --email or --all');
  }
  return email === undefined ? { all: true as const } : { all: false as const, email };
}

type Parsed =
  | { readonly kind: 'build'; readonly build: ReturnType<typeof parseBuild> }
  | { readonly kind: 'link'; readonly link: ReturnType<typeof parseLink> }
  | { readonly kind: 'revoke'; readonly revoke: ReturnType<typeof parseRevoke> };

function parse(argv: readonly string[]): Parsed {
  const [program, command, ...rest] = argv;
  if (program !== 'auth') throw new UsageError('expected auth');
  if (command === 'password-list') {
    const [verb, ...options] = rest;
    if (verb !== 'build') throw new UsageError('expected auth password-list build');
    return { kind: 'build', build: parseBuild(options) };
  }
  if (command === 'link') return { kind: 'link', link: parseLink(rest) };
  if (command === 'revoke-sessions') return { kind: 'revoke', revoke: parseRevoke(rest) };
  throw new UsageError('expected password-list build, link or revoke-sessions');
}

const LABEL: Readonly<Record<Parsed['kind'], string>> = {
  build: 'password-list',
  link: 'link',
  revoke: 'revoke-sessions',
};

// Which flag a refused input came from, so the operator knows what to fix without the
// value being repeated back.
const INPUT_FLAG: Partial<Record<string, string>> = {
  AUTH_INPUT_INVALID: '--email',
  AUTH_NOT_FOUND: '--email',
  AUTH_SIGNUP_CLOSED: '--email',
  AUTH_SLUG_INVALID: '--create-organization',
  AUTH_SLUG_TAKEN: '--create-organization',
};

const BAD_INPUT: ReadonlySet<string> = new Set(Object.keys(INPUT_FLAG));

// Only codes, key names and fixed text reach the terminal; never a value, a URL or an
// address.
function report(
  label: string,
  error: unknown,
  stderr: { write(text: string): void },
  flag?: string,
): number {
  if (error instanceof AuthError) {
    if (error.code === 'AUTH_CONFIG_INVALID') {
      stderr.write(`${label}: ${error.code} ${error.key ?? ''}\n`);
      return EXIT_CONFIG;
    }
    if (BAD_INPUT.has(error.code)) {
      stderr.write(`${label}: ${error.code} (${flag ?? INPUT_FLAG[error.code] ?? ''})\n`);
      return EXIT_BAD_INPUT;
    }
    stderr.write(`${label}: ${error.code}\n`);
    return EXIT_DATABASE;
  }
  if (error instanceof DbError) {
    stderr.write(`${label}: ${error.code}\n`);
    return error.code === 'DB_CONFIG_INVALID' ? EXIT_CONFIG : EXIT_DATABASE;
  }
  stderr.write(`${label}: failed\n`);
  return EXIT_DATABASE;
}

// The db config errors name their keys in fixed text; the URL itself is never in them.
function configKeyOf(error: DbError): string {
  return /DREFYN_[A-Z_]+/.exec(error.message)?.[0] ?? '';
}

// Lines on stderr, one JSON object each, with only the ids and reasons auth logs.
function terminalLogger(stderr: { write(text: string): void }): AuthLogger {
  const line = (level: string) => (event: string, fields: Readonly<Record<string, unknown>>) => {
    stderr.write(`${JSON.stringify({ level, event, ...fields })}\n`);
  };
  return { info: () => undefined, warn: line('warn') };
}

async function withDatabases<T>(
  env: Env,
  work: (db: Database, authDb: AuthDatabase) => Promise<T>,
): Promise<T> {
  const appConfig = parseDatabaseConfig(env);
  const authConfig = parseAuthDatabaseConfig(env);
  const opened: (Database | AuthDatabase)[] = [];
  try {
    const db = await createDatabase(appConfig);
    opened.push(db);
    const authDb = await createAuthDatabase(authConfig);
    opened.push(authDb);
    return await work(db, authDb);
  } finally {
    for (const handle of opened) await closeDatabase(handle).catch(() => undefined);
  }
}

async function runLink(
  config: AuthConfig,
  options: RunAuthCommandOptions,
  input: ReturnType<typeof parseLink>,
): Promise<number> {
  const { env, stdout, stderr } = options;
  const checked = checkCliLinkInput(input);
  if (!checked.ok) {
    // The address is checked first, so a refusal with a good address is the name's.
    const flag = checkCliLinkInput({ email: input.email }).ok ? '--create-organization' : '--email';
    return report('link', checked.error, stderr, flag);
  }
  return withDatabases(env, async (db, authDb) => {
    const links = createCliLinks(config, {
      db,
      authDb,
      logger: terminalLogger(stderr),
      initialTier: 'self_hosted',
    });
    const issued = await links.issue(input);
    if (!issued.ok) return report('link', issued.error, stderr);
    // The link alone on stdout, so it can be piped; the rule goes to stderr.
    stdout.write(`${issued.value.link}\n`);
    stderr.write('Valid once, for 15 minutes.\n');
    return EXIT_DONE;
  });
}

async function runRevoke(
  options: RunAuthCommandOptions,
  input: ReturnType<typeof parseRevoke>,
): Promise<number> {
  const { env, stdout, stderr } = options;
  return withDatabases(env, async (db, authDb) => {
    const operator = createOperatorSessions({ db, authDb, logger: terminalLogger(stderr) });
    let ended: number;
    if (input.all) {
      ended = await operator.revokeAll();
    } else {
      const result = await operator.revokeForEmail(input.email);
      if (!result.ok) return report('revoke-sessions', result.error, stderr);
      ended = result.value;
    }
    stdout.write(`revoke-sessions: ended ${String(ended)} sessions\n`);
    return EXIT_DONE;
  });
}

// The `drefyn auth` commands; returns the exit code. The list build reads no environment
// and opens no connection, so it runs on any machine with the downloaded file. link and
// revoke-sessions read the dashboard's own settings and never send mail.
export async function runAuthCommand(options: RunAuthCommandOptions): Promise<number> {
  const { stdout, stderr } = options;
  let parsed: Parsed;
  try {
    parsed = parse(options.argv);
  } catch (error) {
    const label = options.argv[1] ?? 'auth';
    const safe = ['password-list', 'link', 'revoke-sessions'].includes(label) ? label : 'auth';
    stderr.write(`${safe}: ${(error as Error).message}\n${AUTH_COMMAND_USAGE}\n`);
    return EXIT_BAD_INPUT;
  }
  if (parsed.kind === 'build') return runBuild(parsed.build, stdout, stderr);
  const label = LABEL[parsed.kind];
  try {
    const config = parseAuthConfig(options.env);
    // Checked here too, so a missing URL is a config problem and never a connection attempt.
    parseDatabaseConfig(options.env);
    parseAuthDatabaseConfig(options.env);
    if (parsed.kind === 'link') return await runLink(config, options, parsed.link);
    return await runRevoke(options, parsed.revoke);
  } catch (error) {
    if (error instanceof DbError && error.code === 'DB_CONFIG_INVALID') {
      stderr.write(`${label}: ${error.code} ${configKeyOf(error)}\n`);
      return EXIT_CONFIG;
    }
    return report(label, error, stderr);
  }
}

async function runBuild(
  build: ReturnType<typeof parseBuild>,
  stdout: { write(text: string): void },
  stderr: { write(text: string): void },
): Promise<number> {
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
