import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import tseslint from 'typescript-eslint';
import { exportEntries, isRecord, type WorkspacePackage } from './workspace.ts';

// A pure entry is loaded where Node is absent (client components), so its whole module
// graph may hold relative imports and `import type` of packages, and nothing else.

interface Node {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

interface Parser {
  parseForESLint(code: string, options: Record<string, unknown>): { ast: Node };
}

interface Load {
  specifier: string | undefined;
  line: number;
  // A type only import is erased; a dynamic one runs at an unknown time.
  how: 'static' | 'type' | 'dynamic';
}

const isNode = (value: unknown): value is Node =>
  isRecord(value) && typeof value['type'] === 'string';

function literal(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis'];
    const expressions = node['expressions'];
    if (Array.isArray(expressions) && expressions.length === 0 && Array.isArray(quasis)) {
      const cooked = (quasis[0] as { value?: { cooked?: unknown } } | undefined)?.value?.cooked;
      if (typeof cooked === 'string') return cooked;
    }
  }
  return undefined;
}

function loadsOf(file: string): Load[] {
  const parser = tseslint.parser as unknown as Parser;
  const { ast } = parser.parseForESLint(readFileSync(file, 'utf8'), {
    loc: true,
    filePath: file,
    jsx: file.endsWith('x'),
  });
  const loads: Load[] = [];
  const visit = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    switch (node.type) {
      case 'ImportDeclaration':
        loads.push({
          specifier: literal(node['source']),
          line,
          // Under verbatimModuleSyntax, import { type A } still loads the module.
          how: node['importKind'] === 'type' ? 'type' : 'static',
        });
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node['source'] !== null && node['source'] !== undefined) {
          loads.push({
            specifier: literal(node['source']),
            line,
            how: node['exportKind'] === 'type' ? 'type' : 'static',
          });
        }
        break;
      case 'ImportExpression':
        loads.push({ specifier: literal(node['source']), line, how: 'dynamic' });
        break;
      case 'TSImportType': {
        const argument = node['argument'];
        const inner =
          isNode(argument) && argument.type === 'TSLiteralType' ? argument['literal'] : argument;
        loads.push({ specifier: literal(inner), line, how: 'type' });
        break;
      }
      case 'TSExternalModuleReference':
        loads.push({ specifier: literal(node['expression']), line, how: 'static' });
        break;
      case 'CallExpression': {
        const callee = node['callee'];
        if (isNode(callee) && callee.type === 'Identifier' && callee['name'] === 'require') {
          const [arg] = Array.isArray(node['arguments']) ? (node['arguments'] as unknown[]) : [];
          loads.push({ specifier: literal(arg), line, how: 'dynamic' });
        }
        break;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) {
        visit(value);
      }
    }
  };
  visit(ast);
  return loads;
}

export function checkPureEntries(
  pkg: WorkspacePackage,
  add: (field: string, detail: string) => void,
): void {
  const drefyn = pkg.manifest['drefyn'];
  if (!isRecord(drefyn) || drefyn['pureEntries'] === undefined) return;
  const list = drefyn['pureEntries'];
  if (!Array.isArray(list)) {
    add('drefyn.pureEntries', 'must be a list of export keys');
    return;
  }
  const entries = exportEntries(pkg.manifest['exports']);
  const targets = new Map(typeof entries === 'string' ? [] : entries);
  let badItem = false;
  for (const key of list) {
    if (typeof key !== 'string') {
      badItem = true;
      continue;
    }
    const target = targets.get(key);
    if (typeof target !== 'string') {
      add('drefyn.pureEntries', `'${key}' is not a string entry in exports`);
      continue;
    }
    walkEntry(pkg, key, resolve(pkg.dir, target), add);
  }
  if (badItem) add('drefyn.pureEntries', 'must be a list of export keys');
}

function walkEntry(
  pkg: WorkspacePackage,
  key: string,
  start: string,
  add: (field: string, detail: string) => void,
) {
  const where = (file: string, line: number) =>
    `${relative(pkg.dir, file).split(sep).join('/')}:${String(line)}`;
  const seen = new Set<string>();
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    for (const { specifier, line, how } of loadsOf(file)) {
      const at = where(file, line);
      const entry = `pure entry '${key}'`;
      if (specifier === undefined) {
        add(at, `${entry} loads a computed specifier`);
      } else if (specifier.startsWith('node:') || isBuiltin(specifier)) {
        add(at, `${entry} imports Node built in '${specifier}'`);
      } else if (how === 'dynamic') {
        add(at, `${entry} loads '${specifier}' dynamically`);
      } else if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(pkg.dir + sep)) {
          add(at, `${entry} imports '${specifier}' from outside the package`);
        } else if (!existsSync(target)) {
          add(at, `${entry} imports '${specifier}', which does not exist`);
        } else {
          queue.push(target);
        }
      } else if (how === 'static') {
        add(at, `${entry} loads package '${specifier}' at runtime; only 'import type' is allowed`);
      }
    }
  }
}
