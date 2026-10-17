import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import tseslint from 'typescript-eslint';
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
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
// The same folders the root ESLint config ignores, so the directive scan reads exactly
// what lint reads. The guard step lints the rest, force added files included.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
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

// What a directive comment turns off, or undefined when it is not a directive.
function disabledRules(comment: string): string[] | undefined {
  const text = comment.trim();
  const disable = /^eslint-disable(?:-next-line|-line)?(?:\s+([\s\S]*))?$/.exec(text);
  if (disable) {
    const list = (disable[1] ?? '').split(/(?:^|\s)--(?:\s|$)/)[0] ?? '';
    return list
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const config = /^eslint\s+([\s\S]*)$/.exec(text);
  if (config?.[1] !== undefined) {
    const names = configRuleNames(config[1]);
    return GUARDED_RULES.filter((rule) => names.some((name) => name.includes(rule)));
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

function codeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of sorted(readdirSync(dir, { withFileTypes: true }))) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
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
      const rules = disabledRules(value);
      if (rules === undefined) continue;
      const add = (detail: string) => {
        findings.push({
          package: owner ? label(owner) : 'root',
          field: `${where}:${line}`,
          detail,
        });
      };
      if (rules.length === 0 && /^\s*eslint-disable/.test(value)) {
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
    }
    checkDependencies(pkg, workspace, add);
  }
  findings.push(...checkNestedFiles(workspace));
  const files = codeFiles(root);
  findings.push(...checkDirectives(workspace, files));
  return { findings, workspace: workspace.packages.length, packages, files: files.length };
}
