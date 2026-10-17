import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface WorkspacePackage {
  // Absolute directory, and the same path relative to the root with forward slashes.
  dir: string;
  rel: string;
  name: string | undefined;
  manifest: Record<string, unknown>;
  // Set when package.json exists but cannot be parsed, so the checker can say so.
  invalid?: true;
}

export interface Workspace {
  root: string;
  rootManifest: Record<string, unknown>;
  packages: WorkspacePackage[];
}

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findWorkspaceRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Only the packages list matters here, and pnpm writes it as a plain block sequence.
// Anything else is refused so a layout change cannot silently drop packages from the
// boundary checks.
export function parseWorkspacePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inPackages = /^packages\s*:/.test(raw);
      if (inPackages && !/^packages\s*:\s*(#.*)?$/.test(raw)) {
        throw new Error(`pnpm-workspace.yaml: cannot read '${trimmed}'; use a block list`);
      }
      continue;
    }
    if (!inPackages) continue;
    const match = /^-\s+(?:'([^']*)'|"([^"]*)"|([^\s#'"]+))\s*(?:#.*)?$/.exec(trimmed);
    const pattern = match?.[1] ?? match?.[2] ?? match?.[3];
    if (pattern === undefined) {
      throw new Error(`pnpm-workspace.yaml: cannot read packages entry '${trimmed}'`);
    }
    patterns.push(pattern);
  }
  return patterns;
}

function readManifest(path: string): { manifest: Record<string, unknown>; invalid?: true } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? { manifest: parsed } : { manifest: {}, invalid: true };
  } catch {
    return { manifest: {}, invalid: true };
  }
}

function expand(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const star = clean.endsWith('/*') ? clean.slice(0, -2) : undefined;
  const base = star ?? clean;
  if (/[*?[\]{}!]/.test(base) || base.startsWith('/') || base.split('/').includes('..')) {
    throw new Error(`pnpm-workspace.yaml: unsupported workspace pattern '${pattern}'`);
  }
  const has = (rel: string) => existsSync(join(root, rel, 'package.json'));
  if (star === undefined) return has(base) ? [base] : [];
  if (!existsSync(join(root, base))) return [];
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${base}/${entry.name}`)
    .filter(has);
}

export function loadWorkspace(root: string): Workspace {
  const patterns = parseWorkspacePatterns(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      for (const rel of expand(root, pattern.slice(1))) excluded.add(rel);
    } else {
      for (const rel of expand(root, pattern)) included.add(rel);
    }
  }
  const packages = [...included]
    .filter((rel) => !excluded.has(rel))
    .sort()
    .map((rel): WorkspacePackage => {
      const dir = join(root, ...rel.split('/'));
      const { manifest, invalid } = readManifest(join(dir, 'package.json'));
      const name = typeof manifest['name'] === 'string' ? manifest['name'] : undefined;
      return { dir, rel, name, manifest, ...(invalid ? { invalid } : {}) };
    });
  return { root, rootManifest: readManifest(join(root, 'package.json')).manifest, packages };
}

export function ownerOf(workspace: Workspace, file: string): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const pkg of workspace.packages) {
    if (file !== pkg.dir && !file.startsWith(pkg.dir + sep)) continue;
    if (best === undefined || pkg.dir.length > best.dir.length) best = pkg;
  }
  return best;
}

export function declaredDependencies(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = manifest[field];
    if (isRecord(deps)) for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

// Subpath keys of an exports map. A string or a conditions object is the "." entry.
export function exportKeys(exports: unknown): string[] {
  if (typeof exports === 'string') return ['.'];
  if (!isRecord(exports)) return [];
  const keys = Object.keys(exports);
  if (keys.length > 0 && keys.every((key) => !key.startsWith('.'))) return ['.'];
  return keys.filter((key) => key.startsWith('.'));
}

const cache = new Map<string, Workspace>();

// ESLint builds a rule once per file, so manifests are read once per root and process.
// An editor's long running ESLint server needs a restart to see a manifest change.
export function cachedWorkspace(root: string): Workspace {
  let workspace = cache.get(root);
  if (workspace === undefined) {
    workspace = loadWorkspace(root);
    cache.set(root, workspace);
  }
  return workspace;
}
