import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { canAssign, permissionsFor, type OrgRole, type Permission } from '../../src/permissions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', '..', 'src', 'permissions.ts');

// Building a TypeScript program took 0.5 s alone and 22 s inside the full gate, where
// every package tests at once with coverage. 60 s is that loaded maximum times 2.7.
const COMPILE_TIMEOUT_MS = 60_000;

let previous: ts.Program | undefined;

// The permissions entry is loaded in client components, so it must compile with no Node
// types at all: a Node global or module anywhere in its graph is a compile error here.
// Each program reuses the last one, so the standard library is parsed once.
function diagnosticsWithoutNode(file: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    lib: ['lib.es2024.d.ts'],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram({
    rootNames: [file],
    options,
    ...(previous === undefined ? {} : { oldProgram: previous }),
  });
  previous = program;
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('@drefyn/auth/permissions', () => {
  it(
    'compiles with no Node types',
    () => {
      expect(diagnosticsWithoutNode(entry)).toEqual([]);
    },
    COMPILE_TIMEOUT_MS,
  );

  it(
    'would fail that compile if it used a Node global',
    () => {
      expect(diagnosticsWithoutNode(join(here, 'fixtures', 'uses-node.ts')).join('\n')).toMatch(
        /Buffer/,
      );
    },
    COMPILE_TIMEOUT_MS,
  );

  it('types roles and permissions as closed unions', () => {
    expectTypeOf<OrgRole>().toEqualTypeOf<'owner' | 'admin' | 'member'>();
    expectTypeOf<'org.read'>().toExtend<Permission>();
    expectTypeOf<'org.write'>().not.toExtend<Permission>();
    // @ts-expect-error an unknown role
    expectTypeOf(canAssign).toBeCallableWith('root', 'member');
    // @ts-expect-error product reach is a set of products
    expectTypeOf(permissionsFor).toBeCallableWith('owner', new Set(['website']));
  });
});
