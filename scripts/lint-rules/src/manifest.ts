import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import tseslint from 'typescript-eslint';
import {
  DEPENDENCY_FIELDS,
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
  packages: number;
  files: number;
}

export const GUARDED_RULES = ['drefyn/no-cross-package-internals', 'drefyn/no-raw-egress'];

// Only these trees hold product packages; scripts/* are repo tooling with no API.
const LAYOUT_ROOTS = ['packages/', 'apps/'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', 'out']);

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

function exportEntries(exports: unknown): [string, unknown][] | string {
  if (typeof exports === 'string') return [['.', exports]];
  if (!isRecord(exports)) return 'must be a string or an object';
  const keys = Object.keys(exports);
  const subpaths = keys.filter((key) => key.startsWith('.'));
  if (subpaths.length === 0) return [['.', exports]];
  if (subpaths.length !== keys.length) return 'mixes subpath keys and condition keys';
  return Object.entries(exports);
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
  for (const [script, tool] of [
    ['lint', 'eslint'],
    ['typecheck', 'tsc'],
  ] as const) {
    const command = scripts[script];
    if (typeof command !== 'string' || !command.includes(tool)) {
      add(`scripts.${script}`, `must run ${tool}; the boundary rules only run through it`);
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

// ESLint uses the nearest config file, so one inside a package would silently replace
// the root config and the drefyn rules with it.
function checkEslintConfig(pkg: WorkspacePackage, add: (field: string, detail: string) => void) {
  for (const entry of readdirSync(pkg.dir)) {
    if (/^eslint\.config\.[cm]?[jt]s$/.test(entry)) {
      add(entry, 'replaces the root config and drops the drefyn rules');
    }
  }
}

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
    const body = config[1];
    return GUARDED_RULES.filter((rule) => body.includes(rule));
  }
  return undefined;
}

function codeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
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
    checkEslintConfig(pkg, add);
    checkDependencies(pkg, workspace, add);
  }
  const files = codeFiles(root);
  findings.push(...checkDirectives(workspace, files));
  return { findings, packages, files: files.length };
}
