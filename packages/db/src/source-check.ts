import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultMigrationsDir } from './constants.ts';

export interface SourceProblem {
  readonly file: string;
  readonly line: number;
  // The offending statement or call, trimmed to one line.
  readonly statement: string;
  readonly message: string;
}

type TokenKind = 'word' | 'quoted' | 'string' | 'body' | 'punct';

interface Token {
  readonly kind: TokenKind;
  // Words are lower cased, as Postgres folds them; quoted names keep their case.
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

// Skips comments, keeps strings and dollar quoted bodies whole, so a semicolon or keyword
// inside either never splits a statement or counts as SQL. Never throws: an unterminated
// string or comment runs to the end of the text.
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? n : eol + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
    } else if (c === "'") {
      const start = i;
      i = endOfString(sql, i + 1, false);
      tokens.push({ kind: 'string', value: sql.slice(start + 1, i - 1), start, end: i });
    } else if (c === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (sql.charAt(i) === '"') {
          if (sql.charAt(i + 1) === '"') i += 2;
          else break;
        } else {
          i += 1;
        }
      }
      i = Math.min(i + 1, n);
      tokens.push({
        kind: 'quoted',
        value: sql.slice(start + 1, i - 1).replace(/""/g, '"'),
        start,
        end: i,
      });
    } else if (c === '$' && DOLLAR_TAG.test(sql.slice(i, i + 66))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66))?.[0] ?? '$$';
      const start = i;
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? n : close + tag.length;
      tokens.push({
        kind: 'body',
        value: sql.slice(i + tag.length, close === -1 ? n : close),
        start,
        end,
      });
      i = end;
    } else if (WORD_START.test(c)) {
      const start = i;
      while (i < n && WORD_PART.test(sql.charAt(i))) i += 1;
      const word = sql.slice(start, i);
      // E'...' strings take backslash escapes.
      if ((word === 'e' || word === 'E') && sql.charAt(i) === "'") {
        i = endOfString(sql, i + 1, true);
        tokens.push({ kind: 'string', value: sql.slice(start + 2, i - 1), start, end: i });
      } else {
        tokens.push({ kind: 'word', value: word.toLowerCase(), start, end: i });
      }
    } else {
      tokens.push({ kind: 'punct', value: c, start: i, end: i + 1 });
      i += 1;
    }
  }
  return tokens;
}

function endOfString(sql: string, from: number, backslash: boolean): number {
  let i = from;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (backslash && c === '\\') {
      i += 2;
    } else if (c === "'") {
      if (sql.charAt(i + 1) === "'") i += 2;
      else return i + 1;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

interface Statement {
  readonly tokens: readonly Token[];
  readonly start: number;
  readonly end: number;
}

function statements(sql: string): Statement[] {
  const out: Statement[] = [];
  let current: Token[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first !== undefined && last !== undefined) {
      out.push({ tokens: current, start: first.start, end: last.end });
    }
    current = [];
  };
  for (const token of tokenize(sql)) {
    if (token.kind === 'punct' && token.value === ';') flush();
    else current.push(token);
  }
  flush();
  return out;
}

const ident = (t: Token | undefined): string | undefined =>
  t?.kind === 'word' || t?.kind === 'quoted' ? t.value : undefined;
const isWord = (t: Token | undefined, ...words: string[]): boolean =>
  t?.kind === 'word' && words.includes(t.value);
const isPunct = (t: Token | undefined, value: string): boolean =>
  t?.kind === 'punct' && t.value === value;

const VERBS = ['create', 'alter', 'drop'];

// Words that sit between the verb and the object name in DDL.
const OBJECT_WORDS = new Set([
  'or',
  'replace',
  'temp',
  'temporary',
  'unlogged',
  'global',
  'local',
  'recursive',
  'materialized',
  'unique',
  'trusted',
  'procedural',
  'table',
  'tables',
  'view',
  'views',
  'sequence',
  'sequences',
  'index',
  'function',
  'functions',
  'procedure',
  'procedures',
  'routine',
  'routines',
  'aggregate',
  'type',
  'types',
  'domain',
  'operator',
  'class',
  'family',
  'collation',
  'conversion',
  'text',
  'search',
  'parser',
  'dictionary',
  'template',
  'configuration',
  'statistics',
  'trigger',
  'event',
  'foreign',
  'data',
  'wrapper',
  'server',
  'language',
  'cast',
  'transform',
  'publication',
  'subscription',
  'policy',
  'rule',
  'access',
  'method',
  'constraint',
  'large',
  'object',
  'column',
  'all',
  'in',
  'if',
  'not',
  'exists',
  'concurrently',
  'only',
]);

interface Name {
  readonly schema: string | undefined;
  readonly name: string;
  readonly end: number;
}

// A name at i: ident or ident.ident.
function nameAt(tokens: readonly Token[], i: number): Name | undefined {
  const first = ident(tokens[i]);
  if (first === undefined) return undefined;
  const second = ident(tokens[i + 2]);
  if (isPunct(tokens[i + 1], '.') && second !== undefined) {
    return { schema: first, name: second, end: i + 3 };
  }
  return { schema: undefined, name: first, end: i + 1 };
}

function skipWords(tokens: readonly Token[], from: number, words: ReadonlySet<string>): number {
  let i = from;
  for (let t = tokens[i]; t?.kind === 'word' && words.has(t.value); t = tokens[i]) i += 1;
  return i;
}

function skipGroup(tokens: readonly Token[], from: number): number {
  if (!isPunct(tokens[from], '(')) return from;
  let depth = 0;
  for (let i = from; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], '(')) depth += 1;
    else if (isPunct(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

// Every name in a comma separated list starting at i, such as drop function a(), b().
function namesInList(tokens: readonly Token[], from: number): Name[] {
  const names: Name[] = [];
  let i = from;
  for (;;) {
    const name = nameAt(tokens, i);
    if (name === undefined) return names;
    names.push(name);
    i = skipGroup(tokens, name.end);
    if (!isPunct(tokens[i], ',')) return names;
    i += 1;
  }
}

const inExtensions = (names: readonly (Name | undefined)[]): boolean =>
  names.some((n) => n?.schema === 'extensions');

const CONDITIONS = new Set(['if', 'not', 'exists']);
const ON_TABLE = ['index', 'policy', 'trigger', 'rule'];

// The extension and schema extensions forms, wherever they appear in the token stream.
function namesExtension(tokens: readonly Token[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isWord(t, ...VERBS)) {
      let j = i + 1;
      while (isWord(tokens[j], 'or', 'replace')) j += 1;
      if (isWord(tokens[j], 'extension')) return true;
    }
    if (isWord(t, 'comment') && isWord(tokens[i + 1], 'on') && isWord(tokens[i + 2], 'extension')) {
      return true;
    }
    // schema extensions in any position (create, alter, drop, grant, set schema, in schema),
    // but not a column named schema typed extensions.vector.
    if (isWord(t, 'schema')) {
      const name = nameAt(tokens, skipWords(tokens, i + 1, CONDITIONS));
      if (name?.schema === undefined && name?.name === 'extensions') return true;
    }
  }
  return false;
}

// Whether the statement's own target lives in schema extensions.
function targetsExtensions(tokens: readonly Token[]): boolean {
  const verb = tokens[0];
  if (isWord(verb, ...VERBS)) {
    const at = skipWords(tokens, 1, OBJECT_WORDS);
    const targets = isWord(verb, 'drop') ? namesInList(tokens, at) : [nameAt(tokens, at)];
    if (inExtensions(targets)) return true;
    // An index, policy, trigger or rule names its table after on.
    const onTable = tokens.slice(1, at).some((t) => isWord(t, ...ON_TABLE));
    const on = tokens.findIndex((t) => isWord(t, 'on'));
    if (!onTable || on === -1) return false;
    return inExtensions([nameAt(tokens, skipWords(tokens, on + 1, OBJECT_WORDS))]);
  }
  if (isWord(verb, 'comment') && isWord(tokens[1], 'on')) {
    return inExtensions([nameAt(tokens, skipWords(tokens, 2, OBJECT_WORDS))]);
  }
  if (isWord(verb, 'grant', 'revoke')) {
    const on = tokens.findIndex((t) => isWord(t, 'on'));
    if (on === -1) return false;
    return inExtensions(namesInList(tokens, skipWords(tokens, on + 1, OBJECT_WORDS)));
  }
  return false;
}

const DYNAMIC_EXTENSION = /\bextensions?\b/i;
const EXECUTE = /\bexecute\b/i;

// Dynamic SQL hides its statement in a string, so any execute in a do block or function
// body whose text names an extension or schema extensions is refused.
function bodyNamesExtension(statement: Statement): boolean {
  const first = statement.tokens[0];
  const routine =
    isWord(first, 'do') ||
    (isWord(first, 'create') &&
      statement.tokens.some((t, i) => i < 5 && isWord(t, 'function', 'procedure')));
  if (!routine) return false;
  return statement.tokens.some((t) => {
    if (t.kind !== 'body' && t.kind !== 'string') return false;
    if (EXECUTE.test(t.value) && DYNAMIC_EXTENSION.test(t.value)) return true;
    return t.kind === 'body' && namesExtension(tokenize(t.value));
  });
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charAt(i) === '\n') line += 1;
  return line;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

const EXTENSION_MESSAGE =
  'migrations never create, change or drop an extension or anything in schema extensions; the bootstrap role owns them, so it is an operator step';

// Migration DDL whose target is an extension or schema extensions.
export function extensionDdlProblems(file: string, sql: string): readonly SourceProblem[] {
  const problems: SourceProblem[] = [];
  for (const statement of statements(sql)) {
    const bad =
      namesExtension(statement.tokens) ||
      targetsExtensions(statement.tokens) ||
      bodyNamesExtension(statement);
    if (!bad) continue;
    problems.push({
      file,
      line: lineAt(sql, statement.start),
      statement: oneLine(sql.slice(statement.start, statement.end)),
      message: EXTENSION_MESSAGE,
    });
  }
  return problems;
}

export function migrationDirProblems(dir: string): readonly SourceProblem[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap((name) => extensionDdlProblems(name, readFileSync(join(dir, name), 'utf8')));
}

// Postgres reads these as false for a boolean argument.
const FALSE_VALUES = new Set(['false', 'f', 'fa', 'fal', 'fals', 'off', 'of', 'no', 'n', '0']);
const SET_CONFIG = /(?<![A-Za-z0-9_$])set_config\s*\(/gi;
// A session level SET of a drefyn setting: SET and SET SESSION, never SET LOCAL.
const SESSION_SET = /(?<![A-Za-z0-9_$])set\s+(?:session\s+)?"?drefyn\./gi;

// Top level arguments of a call whose opening parenthesis ends at from, and where it closes.
function callArguments(text: string, from: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = from;
  for (let i = from; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote !== undefined) {
      if (c === '\\' && quote !== "'") i += 1;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(text.slice(start, i));
        return { args, end: i + 1 };
      }
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return { args, end: text.length };
}

function isFalse(argument: string): boolean {
  const bare = argument
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .replace(/::\s*bool(?:ean)?$/i, '')
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim()
    .toLowerCase();
  return FALSE_VALUES.has(bare);
}

// Session scoped tenant settings: a session level SET of a drefyn setting, and set_config
// with is_local false.
export function sessionSettingProblems(file: string, text: string): readonly SourceProblem[] {
  const problems: SourceProblem[] = [];
  for (const match of text.matchAll(SET_CONFIG)) {
    const { args, end } = callArguments(text, match.index + match[0].length);
    const local = args[2];
    if (local === undefined || !isFalse(local)) continue;
    problems.push({
      file,
      line: lineAt(text, match.index),
      statement: oneLine(text.slice(match.index, Math.min(end, match.index + 400))),
      message: 'set_config with is_local false keeps the setting for the whole session',
    });
  }
  for (const match of text.matchAll(SESSION_SET)) {
    const rest = text.slice(match.index);
    const stop = rest.search(/[;\n]/);
    problems.push({
      file,
      line: lineAt(text, match.index),
      statement: oneLine(stop === -1 ? rest : rest.slice(0, stop)),
      message:
        'a session level SET of a drefyn setting outlives the transaction on a pooled connection',
    });
  }
  return problems.sort((a, b) => a.line - b.line);
}

// The fixtures this check is tested with, and nothing else.
const REVIEWED_FIXTURES = 'packages/db/test/fixtures/session-settings/';
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

function trackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\0').filter((path) => path !== '');
}

// Every tracked text file in the repository, except the reviewed fixture folders.
export function repoSourceProblems(root: string): readonly SourceProblem[] {
  const problems: SourceProblem[] = [];
  for (const path of trackedFiles(root)) {
    if (path.startsWith(REVIEWED_FIXTURES)) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) continue;
    const bytes = readFileSync(full);
    // Binary files (images, fonts) carry NUL bytes and no SQL.
    if (bytes.subarray(0, 8000).includes(0)) continue;
    problems.push(...sessionSettingProblems(path, bytes.toString('utf8')));
  }
  return problems;
}

export interface CheckSourcesIo {
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

const defaultRoot = resolve(import.meta.dirname, '..', '..', '..');

function parseArgs(argv: readonly string[]): { migrationsDir: string; root: string } | string {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (flag !== '--migrations-dir' && flag !== '--root') return `unknown argument ${flag}`;
    if (value === undefined || value === '') return `${flag} needs a value`;
    if (values.has(flag)) return `${flag} given twice`;
    values.set(flag, value);
  }
  return {
    migrationsDir: resolve(values.get('--migrations-dir') ?? defaultMigrationsDir),
    root: resolve(values.get('--root') ?? defaultRoot),
  };
}

export function runCheckSources(io: CheckSourcesIo): number {
  const args = parseArgs(io.argv);
  if (typeof args === 'string') {
    io.stderr.write(
      `check:sources: ${args}\nusage: check:sources [--migrations-dir <dir>] [--root <dir>]\n`,
    );
    return 1;
  }
  const problems = [...migrationDirProblems(args.migrationsDir), ...repoSourceProblems(args.root)];
  if (problems.length === 0) {
    io.stdout.write(
      'check:sources: no extension DDL in migrations and no session tenant settings\n',
    );
    return 0;
  }
  for (const p of problems) {
    io.stderr.write(`check:sources: ${p.file}:${String(p.line)}: ${p.message}: ${p.statement}\n`);
  }
  return 1;
}
