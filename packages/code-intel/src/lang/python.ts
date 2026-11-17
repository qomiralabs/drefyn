import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { docstring, head, literalText } from '../text.ts';
import type { SymbolKind } from '../types.ts';
import { pythonRoutes } from './python-routes.ts';

interface Draft {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly doc: string | null;
  readonly node: Node;
  readonly owner: string;
  readonly visible: boolean;
}

const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

const isDunder = (name: string) => name.startsWith('__') && name.endsWith('__');
const isPublic = (name: string) => !name.startsWith('_') || isDunder(name);

// The first statement of a body, when it is a plain string.
function docOf(definition: Node): string | null {
  const body = definition.childForFieldName('body');
  const first = body?.namedChildren.find((child) => child.type !== 'comment');
  if (first?.type !== 'expression_statement' || first.namedChildCount !== 1) return null;
  const value = first.firstNamedChild;
  return value?.type === 'string' && literalText(value) !== undefined
    ? docstring(value.text)
    : null;
}

const unwrap = (node: Node): Node =>
  node.type === 'decorated_definition' ? (node.childForFieldName('definition') ?? node) : node;

function definition(node: Node, owner: string | undefined, drafts: Draft[]): void {
  const target = unwrap(node);
  const name = target.childForFieldName('name')?.text;
  if (name === undefined) return;
  const kind: SymbolKind =
    target.type === 'class_definition' ? 'class' : owner === undefined ? 'function' : 'method';
  if (target.type !== 'class_definition' && target.type !== 'function_definition') return;
  drafts.push({
    name: owner === undefined ? name : `${owner}.${name}`,
    kind,
    signature: head(target, target.childForFieldName('body')),
    doc: docOf(target),
    node: target,
    owner: owner ?? name,
    visible: owner === undefined || isPublic(name),
  });
  if (target.type !== 'class_definition' || owner !== undefined) return;
  for (const member of target.childForFieldName('body')?.namedChildren ?? []) {
    if (unwrap(member).type === 'function_definition') definition(member, name, drafts);
  }
}

// A literal list or tuple of strings, or undefined when it is computed.
function literalNames(value: Node | null): Set<string> | undefined {
  if (value?.type !== 'list' && value?.type !== 'tuple') return undefined;
  const names = new Set<string>();
  for (const item of value.namedChildren) {
    const text = item.type === 'string' ? literalText(item) : undefined;
    if (text === undefined) return undefined;
    names.add(text);
  }
  return names;
}

export function extractPython(root: Node, out: Collector): void {
  const drafts: Draft[] = [];
  let all: Set<string> | undefined;

  for (const node of root.namedChildren) {
    const statement = node.type === 'expression_statement' ? node.firstNamedChild : node;
    if (statement === null) continue;
    if (statement.type === 'assignment' || statement.type === 'augmented_assignment') {
      const left = statement.childForFieldName('left');
      if (left?.type !== 'identifier') continue;
      if (left.text === '__all__') {
        const names =
          statement.type === 'assignment'
            ? literalNames(statement.childForFieldName('right'))
            : undefined;
        // Names built at import time cannot be read here, so the underscore rule stands in.
        if (names === undefined) out.partial = true;
        all = names;
        continue;
      }
      if (statement.type !== 'assignment' || !CONSTANT.test(left.text)) continue;
      const type = statement.childForFieldName('type');
      drafts.push({
        name: left.text,
        kind: 'const',
        signature: type === null ? left.text : `${left.text}: ${head(type, null)}`,
        doc: null,
        node: statement,
        owner: left.text,
        visible: true,
      });
      continue;
    }
    definition(statement, undefined, drafts);
  }

  for (const draft of drafts) {
    const ownerExported = all === undefined ? !draft.owner.startsWith('_') : all.has(draft.owner);
    out.symbol({ ...draft, exported: ownerExported && draft.visible });
  }
  pythonRoutes(root, out);
}
