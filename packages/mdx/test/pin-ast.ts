import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { AST_VERSION } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { AST_CASES, CASE_COMPONENTS } from './ast-cases.ts';
import { asStored, PIN_DIR, pinPath } from './ast-pins.ts';
import { policy } from './helpers.ts';

// Writes the pin for a new astVersion. It never replaces one: rewriting a pin would hide
// exactly the change the pin exists to catch, and stored content still has that shape.
const path = pinPath(AST_VERSION);
if (existsSync(path)) {
  process.stderr.write(`${path} exists. A changed tree needs an astVersion bump.\n`);
  process.exit(1);
}
const trees = Object.fromEntries(
  AST_CASES.map(({ name, source, dialect }) => {
    const result = parseForStore(source, dialect, policy({ components: CASE_COMPONENTS }));
    if (!result.ok) throw new Error(`case ${name} was refused`);
    return [name, asStored(result.value.ast)];
  }),
);
mkdirSync(PIN_DIR, { recursive: true });
writeFileSync(path, `${JSON.stringify(trees, null, 2)}\n`);
execFileSync('pnpm', ['exec', 'prettier', '--write', path], { stdio: 'inherit' });
