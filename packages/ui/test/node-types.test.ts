import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const scratch = mkdtempSync(join(tmpdir(), 'drefyn-ui-types-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function typecheck(project: string): { ok: boolean; output: string } {
  try {
    execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, encoding: 'utf8' });
    return { ok: true, output: '' };
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    return { ok: false, output: stdout ?? String(error) };
  }
}

// The package typecheck includes the DOM library for components and stories. The token
// entry runs in plain Node, so it is also checked without it.
describe('the token entry types', () => {
  it('check without the DOM library', { timeout: 60_000 }, () => {
    expect(typecheck('tsconfig.node.json')).toEqual({ ok: true, output: '' });
  });

  it('reject DOM use under that config', { timeout: 60_000 }, () => {
    writeFileSync(join(scratch, 'dom.ts'), 'export const title = document.title;\n');
    writeFileSync(
      join(scratch, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.node.json'),
        compilerOptions: { typeRoots: [join(root, '..', '..', 'node_modules', '@types')] },
        include: [],
        files: ['dom.ts'],
      }),
    );
    const result = typecheck(join(scratch, 'tsconfig.json'));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Cannot find name 'document'");
    expect(result.output).not.toContain('TS2688');
  });
});
