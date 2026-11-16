import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

// The open core must run with no paid or hosted only service. Billing lives behind a
// provider contract, so a Stripe package or script anywhere in this repo is a mistake,
// whether it comes in directly, through another package, or as a script tag.

export interface OpenCoreFinding {
  readonly package: string;
  readonly reason: string;
}

export interface Lockfile {
  // importer path -> dependency name -> resolved version
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  // snapshot key (name@version) -> dependency name -> resolved version
  readonly snapshots: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const LOCK_DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

const PACKAGE_ROOTS = ['apps', 'packages'];

// Folders that never reach a build: tests, fixtures, installs and build output.
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'fixtures',
]);

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css|html)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`\s]+)\1/g;
const STRIPE_SCRIPT = /js\.stripe\.com/i;

export function isStripePackage(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('@stripe/')) return true;
  const bare = lower.startsWith('@') ? lower.slice(lower.indexOf('/') + 1) : lower;
  return /(?:^|[-_.])stripe(?:[-_.]|$)/.test(bare);
}

function readJson(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${path}: ${message}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`cannot read ${path}: not an object`);
  }
  return parsed as Record<string, unknown>;
}

function packageDirs(root: string): string[] {
  return PACKAGE_ROOTS.flatMap((top) => {
    const dir = join(root, top);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
      .map((entry) => `${top}/${entry.name}`)
      .sort();
  });
}

function packageName(root: string, dir: string): string {
  const path = join(root, dir, 'package.json');
  if (!existsSync(path)) return dir;
  const name = readJson(path)['name'];
  return typeof name === 'string' ? name : dir;
}

export function checkManifests(root: string): OpenCoreFinding[] {
  const findings: OpenCoreFinding[] = [];
  for (const dir of packageDirs(root)) {
    const manifest = readJson(join(root, dir, 'package.json'));
    const name = typeof manifest['name'] === 'string' ? manifest['name'] : dir;
    for (const field of MANIFEST_FIELDS) {
      const deps = manifest[field];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const dep of Object.keys(deps)) {
        if (isStripePackage(dep))
          findings.push({ package: name, reason: `lists ${dep} in ${field}` });
      }
    }
  }
  return findings;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

// One YAML mapping line as pnpm writes it: a plain or quoted key, then nothing or a value.
function entry(text: string): { key: string; value: string } | undefined {
  if (text.startsWith("'") || text.startsWith('"')) {
    const quote = text.charAt(0);
    let end = 1;
    for (;;) {
      end = text.indexOf(quote, end);
      if (end < 0) return undefined;
      if (quote === "'" && text.charAt(end + 1) === "'") {
        end += 2;
        continue;
      }
      break;
    }
    const rest = text.slice(end + 1);
    if (!rest.startsWith(':')) return undefined;
    return { key: unquote(text.slice(0, end + 1)), value: rest.slice(1).trim() };
  }
  const split = text.indexOf(': ');
  if (split >= 0) return { key: text.slice(0, split), value: text.slice(split + 2).trim() };
  if (text.endsWith(':')) return { key: text.slice(0, -1), value: '' };
  return undefined;
}

export function parseLockfile(text: string): Lockfile {
  const importers = new Map<string, Map<string, string>>();
  const snapshots = new Map<string, Map<string, string>>();
  const lines = text.split('\n');

  const version = /^lockfileVersion: '?([^'\s]+)'?$/m.exec(text)?.[1];
  // Another major version may move things this reader looks for, so it stops instead.
  if (version !== '9.0')
    throw new Error(`pnpm-lock.yaml: unknown lockfile version '${version ?? ''}'`);

  let section = '';
  let current: Map<string, string> | undefined;
  let field: string | undefined;
  let dependency: string | undefined;

  const fail = (index: number): never => {
    throw new Error(`pnpm-lock.yaml: cannot read line ${index + 1}: ${lines[index] ?? ''}`);
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    if (indent === 0) {
      section = entry(body)?.key ?? fail(index);
      current = undefined;
      return;
    }
    if (section !== 'importers' && section !== 'snapshots') return;
    if (body.startsWith('- ')) {
      // Only peer lists hold sequences, and nothing here reads them.
      if (field === undefined) return;
      fail(index);
    }
    const parsed = entry(body) ?? fail(index);

    if (indent === 2) {
      current = new Map();
      (section === 'importers' ? importers : snapshots).set(parsed.key, current);
      field = undefined;
      dependency = undefined;
      return;
    }
    if (current === undefined) return fail(index);
    if (indent === 4) {
      const reads =
        section === 'importers'
          ? LOCK_DEPENDENCY_FIELDS.has(parsed.key)
          : parsed.key === 'dependencies' || parsed.key === 'optionalDependencies';
      field = reads ? parsed.key : undefined;
      dependency = undefined;
      return;
    }
    if (field === undefined) return;
    if (section === 'snapshots' && indent === 6) {
      current.set(parsed.key, unquote(parsed.value));
      return;
    }
    if (section === 'importers' && indent === 6) {
      dependency = parsed.key;
      return;
    }
    if (section === 'importers' && indent === 8 && dependency !== undefined) {
      if (parsed.key === 'version') current.set(dependency, unquote(parsed.value));
      return;
    }
    fail(index);
  });

  if (importers.size === 0) throw new Error('pnpm-lock.yaml: no importers found');
  return { importers, snapshots };
}

type Node = { kind: 'importer'; path: string } | { kind: 'package'; key: string };

export function checkLockfile(root: string): OpenCoreFinding[] {
  const lock = parseLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const names = new Map<string, string>();
  const nameOf = (path: string) => {
    let name = names.get(path);
    if (name === undefined) {
      name =
        path === '.' && !existsSync(join(root, 'package.json')) ? '.' : packageName(root, path);
      names.set(path, name);
    }
    return name;
  };

  const findings: OpenCoreFinding[] = [];
  for (const start of lock.importers.keys()) {
    const seen = new Set<string>([`importer:${start}`]);
    const reported = new Set<string>();
    // Breadth first, so each report shows the shortest way in.
    const queue: { node: Node; via: readonly string[] }[] = [
      { node: { kind: 'importer', path: start }, via: [] },
    ];
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const { node, via } = item;
      // Both lookups were checked before the node was queued.
      const deps =
        (node.kind === 'importer' ? lock.importers.get(node.path) : lock.snapshots.get(node.key)) ??
        new Map<string, string>();
      for (const [name, version] of deps) {
        if (version.startsWith('link:')) {
          const base = node.kind === 'importer' ? node.path : '.';
          const path = posix.normalize(posix.join(base, version.slice('link:'.length)));
          if (seen.has(`importer:${path}`)) continue;
          seen.add(`importer:${path}`);
          if (!lock.importers.has(path)) continue;
          queue.push({ node: { kind: 'importer', path }, via: [...via, nameOf(path)] });
          continue;
        }
        const key = `${name}@${version}`;
        if (isStripePackage(name)) {
          if (!reported.has(key)) {
            reported.add(key);
            findings.push({
              package: nameOf(start),
              reason: `depends on ${key} (via ${[...via, key].join(' > ')})`,
            });
          }
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        if (!lock.snapshots.has(key)) {
          throw new Error(`pnpm-lock.yaml: ${start}: ${key} has no snapshot`);
        }
        queue.push({ node: { kind: 'package', key }, via: [...via, key] });
      }
    }
  }
  return findings.sort(byPackage);
}

function shippedFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((item) => {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) {
      return SKIPPED_DIRS.has(item.name) || item.name.startsWith('.')
        ? []
        : shippedFiles(root, path);
    }
    return item.isFile() && SOURCE_FILE.test(item.name) && !TEST_FILE.test(item.name) ? [path] : [];
  });
}

function specifierPackage(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function checkSources(root: string): OpenCoreFinding[] {
  const findings: OpenCoreFinding[] = [];
  for (const top of PACKAGE_ROOTS) {
    if (!existsSync(join(root, top))) continue;
    for (const item of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const dir = `${top}/${item.name}`;
      const name = packageName(root, dir);
      for (const file of shippedFiles(root, dir).sort()) {
        const text = readFileSync(join(root, file), 'utf8');
        const reasons = new Set<string>();
        for (const match of text.matchAll(IMPORT)) {
          const specifier = match[2] ?? '';
          if (isStripePackage(specifierPackage(specifier))) reasons.add(`imports ${specifier}`);
        }
        if (STRIPE_SCRIPT.test(text)) reasons.add('loads js.stripe.com');
        for (const reason of reasons)
          findings.push({ package: name, reason: `${reason} in ${file}` });
      }
    }
  }
  return findings;
}

function byPackage(a: OpenCoreFinding, b: OpenCoreFinding): number {
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
}

export function checkOpenCore(root: string): OpenCoreFinding[] {
  return [...checkManifests(root), ...checkLockfile(root), ...checkSources(root)].sort(byPackage);
}
