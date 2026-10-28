import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import tseslint from 'typescript-eslint';
import { checkAppTheme } from './app-theme.ts';
import { checkPureEntries } from './pure-entries.ts';
import {
  DEPENDENCY_FIELDS,
  exportEntries,
  isRecord,
  loadWorkspace,
  ownerOf,
  type Workspace,
  type WorkspacePackage,
} from './workspace.ts';

export interface Finding {
  package: string;
  field: string;
  detail: string;
}

export interface CheckResult {
  findings: Finding[];
  // Workspace packages found, and how many of them sit under packages/ and apps/.
  workspace: number;
  packages: number;
  files: number;
}

export const GUARDED_RULES = ['drefyn/no-cross-package-internals', 'drefyn/no-raw-egress'];

// Only these trees hold product packages; scripts/* are repo tooling with no API.
const LAYOUT_ROOTS = ['packages/', 'apps/'];
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
// Committed fixture workspaces carry their own configs on purpose.
const FIXTURES = 'scripts/lint-rules/test/fixtures/';

// The exact commands from the package template. Any other flag or wrapper can switch
// the rules off for that package (--rule, -c, --no-config-lookup, --ignore-pattern).
export const REQUIRED_SCRIPTS = {
  lint: 'eslint --max-warnings 0 .',
  typecheck: 'tsc -p tsconfig.json',
} as const;

export function formatFinding(finding: Finding): string {
  return `${finding.package}: ${finding.field}: ${finding.detail}`;
}

const label = (pkg: WorkspacePackage) => `${pkg.rel} (${pkg.name ?? 'no name'})`;

// Each leaf target of an export entry; undefined marks a value that is not a target.
function targets(value: unknown): (string | undefined)[] {
  if (typeof value === 'string') return [value];
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => targets(item));
  if (isRecord(value)) return Object.values(value).flatMap(targets);
  return [undefined];
}

function checkLayout(pkg: WorkspacePackage, add: (field: string, detail: string) => void) {
  const { manifest } = pkg;
  const expected = `@drefyn/${basename(pkg.rel)}`;
  if (pkg.name !== expected) add('name', `must be '${expected}'`);
  const type = manifest['type'];
  if (type !== 'module') {
    add(
      'type',
      `must be 'module', found ${type === undefined ? 'nothing' : JSON.stringify(type).replaceAll('"', "'")}`,
    );
  }

  checkExports(manifest, add);
  // Turbo only lints and typechecks a package through these scripts, so without them
  // the rules and the exports map never see its code.
  const scripts = isRecord(manifest['scripts']) ? manifest['scripts'] : {};
  for (const [script, command] of Object.entries(REQUIRED_SCRIPTS)) {
    if (scripts[script] !== command) {
      add(`scripts.${script}`, `must be '${command}'; the boundary rules only run through it`);
    }
  }
}

function checkExports(
  manifest: Record<string, unknown>,
  add: (field: string, detail: string) => void,
) {
  const exports = manifest['exports'];
  if (exports === undefined) {
    add('exports', "missing; point '.' at ./src/index.ts");
    return;
  }
  const entries = exportEntries(exports);
  if (typeof entries === 'string') {
    add('exports', entries);
    return;
  }
  if (entries.length === 0) add('exports', "has no entry points; point '.' at ./src/index.ts");
  const published = manifest['private'] !== true;
  const base = published ? './dist/' : './src/';
  for (const [key, target] of entries) {
    const field = `exports[${JSON.stringify(key)}]`;
    if (key.includes('*')) add(field, 'wildcard keys are not allowed; list each entry point');
    if (/(^|\/)src(\/|$)/.test(key)) add(field, 'keys must not expose src paths');
    for (const path of targets(target)) {
      if (path === undefined) {
        add(field, 'target must be a string or a conditions object');
      } else if (path.includes('*')) {
        add(field, 'wildcard targets are not allowed');
      } else if (key === './package.json' && path === './package.json') {
        continue;
      } else if (!path.startsWith(base) || path.split('/').includes('..')) {
        add(
          field,
          `target '${path}' must be under ${base} in a ${published ? 'published' : 'private'} package`,
        );
      }
    }
  }
}

const NESTED_FILES: [RegExp, string][] = [
  // ESLint looks up the config from each file's own folder.
  [
    /^eslint\.config\.[cm]?[jt]s$/,
    'replaces the root config and drops the drefyn rules for that folder',
  ],
  // The rules take the nearest pnpm-workspace.yaml as the root.
  [
    /^pnpm-workspace\.yaml$/,
    'starts a separate workspace, so the drefyn rules stop seeing the real packages',
  ],
];

// Every file below the root, dot folders and build output included: a config there
// still changes what ESLint does for its folder.
function checkNestedFiles(workspace: Workspace): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string) => {
    for (const entry of sorted(readdirSync(dir, { withFileTypes: true }))) {
      const full = join(dir, entry.name);
      const rel = relative(workspace.root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && rel + '/' !== FIXTURES) {
          walk(full);
        }
        continue;
      }
      if (dir === workspace.root) continue;
      const detail = NESTED_FILES.find(([pattern]) => pattern.test(entry.name))?.[1];
      if (detail === undefined) continue;
      const owner = ownerOf(workspace, full);
      findings.push({
        package: owner ? label(owner) : 'root',
        field: relative(owner?.dir ?? workspace.root, full)
          .split(sep)
          .join('/'),
        detail,
      });
    }
  };
  walk(workspace.root);
  return findings;
}

// File types allowed outside the reviewed set. Node's require runs any other extension,
// and a file with none (dotfiles included), as JavaScript, and the guard only lists
// source extensions, so such a file would be code nothing lints.
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SOURCE_EXTENSIONS,
  '.json',
  '.css',
  '.md',
  '.txt',
  // Migrations stay plain SQL so review reads the bytes that run. Node cannot run
  // SQL, and a .sql file reaches it as code only the ways a .txt file can.
  '.sql',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

// Paths every change to which needs security review, so they may hold any file type.
// A test keeps these in step with the review gate rules and CODEOWNERS.
export const REVIEWED_PREFIXES: readonly string[] = ['scripts/', '.github/', 'deploy/'];
export const REVIEWED_ROOT_FILES: readonly string[] = [
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'LICENSE',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

const isReviewed = (path: string) =>
  REVIEWED_PREFIXES.some((prefix) => path.startsWith(prefix)) || REVIEWED_ROOT_FILES.includes(path);

interface IndexEntry {
  path: string;
  mode: string;
}

// Tracked entries with their git mode, plus new files that are not ignored, the same
// list the guard lints. Read from git because a symlink or a submodule shows up there
// as one entry whose contents nothing lists. No repository is an error, not a pass.
function indexEntries(root: string): IndexEntry[] {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const detail = typeof stderr === 'string' ? stderr.trim() : String(error);
      throw new Error(`git ${args[0] ?? ''} failed in ${root}: ${detail}`, { cause: error });
    }
  };
  // A path in a merge conflict is listed once per stage; judge it once.
  const entries = new Map<string, IndexEntry>();
  for (const line of git(['ls-files', '-s', '-z']).split('\0')) {
    if (line === '') continue;
    const path = line.slice(line.indexOf('\t') + 1);
    if (!entries.has(path)) entries.set(path, { mode: line.slice(0, line.indexOf(' ')), path });
  }
  for (const listed of git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')) {
    if (listed === '') continue;
    // git lists an untracked nested repository as dir/; nothing inside it is listed,
    // which is the same problem as a submodule.
    if (listed.endsWith('/')) {
      const path = listed.slice(0, -1);
      entries.set(path, { path, mode: '160000' });
      continue;
    }
    const link = lstatSync(join(root, ...listed.split('/'))).isSymbolicLink();
    entries.set(listed, { path: listed, mode: link ? '120000' : '100644' });
  }
  // Path order, so findings read the same whichever list a path came from.
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function checkIndex(workspace: Workspace, entries: readonly IndexEntry[]): Finding[] {
  const findings: Finding[] = [];
  for (const { path, mode } of entries) {
    const segments = path.split('/');
    const full = join(workspace.root, ...segments);
    const owner = ownerOf(workspace, full);
    const add = (detail: string) => {
      findings.push({
        package: owner ? label(owner) : 'root',
        field: relative(owner?.dir ?? workspace.root, full)
          .split(sep)
          .join('/'),
        detail,
      });
    };
    // pnpm never writes into the index, so a committed node_modules entry is always
    // hand made, and Node resolves bare names into it. Every other check still runs.
    if (segments.some((segment) => segment.toLowerCase() === 'node_modules')) {
      add('node_modules is never committed; Node resolves bare names into it and nothing lints it');
    }
    if (segments.some((segment) => segment.startsWith('-'))) {
      add("starts with '-', which tools read as an option");
    }
    if (mode === '120000') {
      add('symlinks are not allowed; the rules and the guard see the link, not its target');
    } else if (mode === '160000') {
      add('submodules are not allowed; nothing inside one is linted');
    } else if (!isReviewed(path)) {
      const name = segments.at(-1) ?? '';
      if (NESTED_FILES.some(([pattern]) => pattern.test(name))) continue;
      const ext = extname(name);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        add(
          `file type ${ext === '' ? '(no extension)' : ext} is not allowed outside scripts/, .github/ and deploy/; Node can load it as code and nothing lints it. ` +
            'To allow a new type, add it to ALLOWED_EXTENSIONS in scripts/lint-rules/src/manifest.ts, which needs security review',
        );
      }
    }
  }
  return findings.sort((a, b) =>
    a.package === b.package ? (a.field < b.field ? -1 : 1) : a.package < b.package ? -1 : 1,
  );
}

const sorted = <T extends { name: string }>(entries: T[]) =>
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

function checkDependencies(
  pkg: WorkspacePackage,
  workspace: Workspace,
  add: (field: string, detail: string) => void,
) {
  const apps = new Set(
    workspace.packages.filter((p) => p.rel.startsWith('apps/')).map((p) => p.name),
  );
  const privates = new Set(
    workspace.packages.filter((p) => p.manifest['private'] === true).map((p) => p.name),
  );
  const published = pkg.manifest['private'] !== true;
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg.manifest[field];
    if (!isRecord(deps)) continue;
    for (const name of Object.keys(deps)) {
      const where = `${field}[${JSON.stringify(name)}]`;
      if (apps.has(name))
        add(where, 'apps are never dependencies; move shared code into a package');
      // A dev dependency never reaches the published tarball, so it may be private.
      if (published && field !== 'devDependencies' && privates.has(name)) {
        add(where, `a published package cannot depend on private ${name}`);
      }
    }
  }
}

interface Comment {
  value: string;
  line: number;
}

interface CommentParser {
  parseForESLint(
    code: string,
    options: Record<string, unknown>,
  ): { ast: { comments?: { value: string; loc: { start: { line: number } } }[] } };
}

function comments(path: string, text: string): Comment[] {
  const ext = extname(path);
  try {
    const parser = tseslint.parser as unknown as CommentParser;
    const { ast } = parser.parseForESLint(text, {
      comment: true,
      loc: true,
      jsx: ext === '.tsx' || ext === '.jsx',
      filePath: path,
    });
    return (ast.comments ?? []).map((c) => ({ value: c.value, line: c.loc.start.line }));
  } catch {
    // A file that does not parse fails lint anyway; scan its text so a directive in it
    // is still caught, at the cost of also matching one inside a string.
    return text.split(/\r?\n/).flatMap((line, i) => {
      const match = /(?:\/\/|\/\*)(.*?)(?:\*\/|$)/.exec(line);
      return match?.[1] === undefined ? [] : [{ value: match[1], line: i + 1 }];
    });
  }
}

interface Directive {
  // eslint-disable and its line forms, or eslint for a rule config comment.
  kind: 'disable' | 'config';
  rules: string[];
}

// Parsed the way ESLint 10 parses comments: the text before the first run of two or
// more dashes between spaces is the directive, the label is lower case words joined by
// dashes, and a disable list is split on commas with one pair of matching quotes
// stripped from each name. Anything ESLint would not read as a directive is not one.
function parseDirective(comment: string): Directive | undefined {
  const marker = /\s-{2,}\s/u.exec(comment);
  const text = (marker ? comment.slice(0, marker.index) : comment).trim();
  const label = /^([a-z]+(?:-[a-z]+)*)(?:\s|$)/u.exec(text)?.[1];
  if (label === undefined) return undefined;
  const value = text.slice(label.length).trim();
  if (/^eslint-disable(?:-next-line|-line)?$/.test(label)) {
    const rules = value
      .split(',')
      .map((name) => name.trim().replace(/^(['"]?)(.*)\1$/su, '$2'))
      .filter((name) => name !== '');
    return { kind: 'disable', rules };
  }
  if (label === 'eslint') {
    const names = configRuleNames(value);
    return {
      kind: 'config',
      rules: GUARDED_RULES.filter((rule) => names.some((name) => name.includes(rule))),
    };
  }
  return undefined;
}

// ESLint decodes a rule config comment as JSON or a looser JSON like form, so a name
// can hide behind escapes such as \u002d. Match the decoded keys and the text with its
// escapes undone; the guard step, which ignores config comments, backs this up.
function configRuleNames(body: string): string[] {
  const unescaped = body
    .replace(/\\u\{?([0-9a-fA-F]{1,6})\}?/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, '$1');
  const names = [body, unescaped];
  try {
    const parsed: unknown = JSON.parse(`{${body}}`);
    if (isRecord(parsed)) names.push(...Object.keys(parsed));
  } catch {
    // Not JSON; the text forms above still apply.
  }
  return names;
}

// Source files in the tree, the same list the guard lints: tracked or new, dot folders
// and force added build output included, fixtures and links left out. A tracked file
// missing from disk is skipped, since a checkout cannot have one.
function sourceFiles(root: string, entries: readonly IndexEntry[]): string[] {
  return entries
    .filter(
      ({ path, mode }) =>
        mode !== '120000' &&
        mode !== '160000' &&
        !path.startsWith(FIXTURES) &&
        SOURCE_EXTENSIONS.has(extname(path)),
    )
    .map(({ path }) => join(root, ...path.split('/')))
    .filter((file) => existsSync(file));
}

// Stylesheets under apps/*/src may only compose tokens in their Tailwind theme.
const APP_STYLESHEET = /^apps\/[^/]+\/src\/.+\.css$/;

function checkAppStyles(
  workspace: Workspace,
  root: string,
  entries: readonly IndexEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const { path } of entries) {
    if (!APP_STYLESHEET.test(path)) continue;
    const file = join(root, ...path.split('/'));
    if (!existsSync(file)) continue;
    const owner = ownerOf(workspace, file);
    const where = relative(owner?.dir ?? workspace.root, file)
      .split(sep)
      .join('/');
    for (const finding of checkAppTheme(readFileSync(file, 'utf8'))) {
      findings.push({
        package: owner === undefined ? path : label(owner),
        field: where,
        detail: finding.detail,
      });
    }
  }
  return findings;
}

function checkDirectives(workspace: Workspace, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('eslint')) continue;
    const owner = ownerOf(workspace, file);
    const where = relative(owner?.dir ?? workspace.root, file)
      .split(sep)
      .join('/');
    for (const { value, line } of comments(file, text)) {
      const directive = parseDirective(value);
      if (directive === undefined) continue;
      const { rules } = directive;
      const add = (detail: string) => {
        findings.push({
          package: owner ? label(owner) : 'root',
          field: `${where}:${line}`,
          detail,
        });
      };
      if (rules.length === 0 && directive.kind === 'disable') {
        add('a blanket eslint-disable also turns off the drefyn rules; name the rules instead');
        continue;
      }
      const guarded = rules.find((rule) => GUARDED_RULES.includes(rule));
      if (guarded !== undefined) add(`inline disable of ${guarded} is not allowed`);
    }
  }
  return findings;
}

export function checkWorkspace(root: string): CheckResult {
  const workspace = loadWorkspace(root);
  const findings: Finding[] = [];
  let packages = 0;
  for (const pkg of workspace.packages) {
    const add = (field: string, detail: string) => {
      findings.push({ package: label(pkg), field, detail });
    };
    if (pkg.invalid) {
      add('package.json', 'not valid JSON');
      continue;
    }
    if (LAYOUT_ROOTS.some((prefix) => pkg.rel.startsWith(prefix))) {
      packages += 1;
      checkLayout(pkg, add);
      checkPureEntries(pkg, add);
    }
    checkDependencies(pkg, workspace, add);
  }
  findings.push(...checkNestedFiles(workspace));
  const entries = indexEntries(root);
  findings.push(...checkIndex(workspace, entries));
  const files = sourceFiles(root, entries);
  findings.push(...checkDirectives(workspace, files));
  findings.push(...checkAppStyles(workspace, root, entries));
  return { findings, workspace: workspace.packages.length, packages, files: files.length };
}
