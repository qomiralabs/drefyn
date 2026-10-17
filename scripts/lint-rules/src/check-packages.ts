import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkWorkspace, formatFinding } from './manifest.ts';
import { findWorkspaceRoot } from './workspace.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `usage: check-packages [--root <dir>]

Checks every workspace package manifest under packages/ and apps/ against the package
layout, every source file for inline disables of the drefyn boundary rules, and the
tree for nested eslint.config.* and pnpm-workspace.yaml files.

  --root <dir>  workspace root (default: the nearest pnpm-workspace.yaml above cwd)

exit codes: 0 clean, 1 problems found, 2 usage or read error
`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function main(argv: string[], io: Io): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { root: { type: 'string' }, help: { type: 'boolean' } },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }

  let result;
  try {
    const root =
      values.root === undefined ? findWorkspaceRoot(process.cwd()) : resolve(values.root);
    if (root === undefined) throw new Error(`no pnpm-workspace.yaml above ${process.cwd()}`);
    result = checkWorkspace(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(
      `check:packages: error: ${message.replace(/^ENOENT: [^,]*, open '(.*)'$/, 'no pnpm-workspace.yaml at $1')}\n`,
    );
    return 2;
  }

  if (result.findings.length === 0) {
    // The workspace count is printed so a reader change that drops packages shows up.
    io.out(
      `check:packages: clean (${count(result.workspace, 'workspace package')}, ` +
        `${result.packages} under packages/ and apps/, ${count(result.files, 'source file')})\n`,
    );
    return 0;
  }
  io.err(result.findings.map((finding) => formatFinding(finding) + '\n').join(''));
  io.err(`check:packages: ${count(result.findings.length, 'problem')}\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
