import { execFileSync } from 'node:child_process';
import { isRecord } from './records.ts';

// Every resolved path of one package in `pnpm list --json --depth Infinity` output, across
// every workspace project and every dependency field.
export function resolvedPaths(listing: unknown, name: string): string[] {
  const paths = new Set<string>();
  const walk = (deps: unknown) => {
    if (!isRecord(deps)) return;
    for (const [key, node] of Object.entries(deps)) {
      if (!isRecord(node)) continue;
      if (key === name && typeof node['path'] === 'string') paths.add(node['path']);
      walk(node['dependencies']);
    }
  };
  for (const project of Array.isArray(listing) ? (listing as unknown[]) : [listing]) {
    if (!isRecord(project)) continue;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      walk(project[field]);
    }
  }
  return [...paths].sort();
}

export function workspaceListing(root: string, name: string): unknown {
  return JSON.parse(
    execFileSync('pnpm', ['-r', 'list', name, '--json', '--depth', 'Infinity'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}
