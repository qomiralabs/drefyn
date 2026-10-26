import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatedFiles } from './generate.ts';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const DEFAULT_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../generated');
const USAGE = 'usage: tokens [--out <dir>] [--check]\n';

export function main(argv: string[], io: Io): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: 'string' }, check: { type: 'boolean' } },
      strict: true,
    }));
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const out = values.out ?? DEFAULT_OUT;
  const files = Object.entries(generatedFiles());
  if (values.check === true) {
    let stale = 0;
    for (const [name, content] of files) {
      const path = join(out, name);
      if (!existsSync(path)) {
        io.err(`${name} is missing\n`);
        stale += 1;
      } else if (readFileSync(path, 'utf8') !== content) {
        io.err(`${name} is out of date\n`);
        stale += 1;
      }
    }
    if (stale > 0) io.err('run `pnpm --filter @drefyn/ui tokens` and commit the result\n');
    return stale > 0 ? 1 : 0;
  }
  mkdirSync(out, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(out, name), content);
  io.out(`wrote ${files.length} files to ${out}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
