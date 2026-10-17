import type { AST, Rule } from 'eslint';
import { isRecord } from './workspace.ts';

export interface ModuleReference {
  spec: string;
  loc: AST.SourceLocation;
  // True when the reference is erased at compile time and loads nothing at run time.
  typeOnly: boolean;
}

function literal(value: unknown): { spec: string; loc: AST.SourceLocation } | undefined {
  if (!isRecord(value) || !isRecord(value['loc'])) return undefined;
  const loc = value['loc'] as unknown as AST.SourceLocation;
  if (value['type'] === 'Literal') {
    return typeof value['value'] === 'string' ? { spec: value['value'], loc } : undefined;
  }
  // A template with no ${} is as static as a string, so it gets the same treatment.
  const expressions: unknown = value['expressions'];
  const quasis: unknown = value['quasis'];
  if (
    value['type'] !== 'TemplateLiteral' ||
    !Array.isArray(expressions) ||
    !Array.isArray(quasis)
  ) {
    return undefined;
  }
  const first: unknown = quasis[0];
  if (expressions.length > 0 || !isRecord(first) || !isRecord(first['value'])) return undefined;
  const cooked = first['value']['cooked'];
  return typeof cooked === 'string' ? { spec: cooked, loc } : undefined;
}

const isType = (node: unknown, key: string) => isRecord(node) && node[key] === 'type';

// Every syntax that names a module by string: static and dynamic imports, re-exports,
// type imports, require() and TypeScript's import x = require().
export function moduleReferences(visit: (reference: ModuleReference) => void): Rule.RuleListener {
  const from = (source: unknown, typeOnly: boolean) => {
    const found = literal(source);
    if (found !== undefined) visit({ ...found, typeOnly });
  };
  return {
    ImportDeclaration: (node) => {
      from(node.source, isType(node, 'importKind'));
    },
    ExportNamedDeclaration: (node) => {
      from(node.source, isType(node, 'exportKind'));
    },
    ExportAllDeclaration: (node) => {
      from(node.source, isType(node, 'exportKind'));
    },
    ImportExpression: (node) => {
      from(node.source, false);
    },
    CallExpression: (node) => {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        from(node.arguments[0], false);
      }
    },
    TSImportType: (node: unknown) => {
      if (isRecord(node)) from(node['source'], true);
    },
    TSImportEqualsDeclaration: (node: unknown) => {
      if (!isRecord(node) || !isRecord(node['moduleReference'])) return;
      if (node['moduleReference']['type'] !== 'TSExternalModuleReference') return;
      from(node['moduleReference']['expression'], isType(node, 'importKind'));
    },
  };
}
