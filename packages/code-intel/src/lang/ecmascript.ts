import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { blockDoc, head, isAttached } from '../text.ts';
import type { SymbolKind } from '../types.ts';
import { ecmascriptRoutes } from './ecmascript-routes.ts';

interface Draft {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly doc: string | null;
  readonly node: Node;
  // The top level name whose export decides this one, and whether this one is public within it.
  readonly owner: string;
  readonly visible: boolean;
}

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'function_expression',
  'function',
  'generator_function',
]);
const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const METHOD_TYPES = new Set([
  'method_definition',
  'abstract_method_signature',
  'method_signature',
]);
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);

// The nearest `/** */` above, past any decorators. A plain comment is not documentation.
function docAbove(node: Node): string | null {
  let current = node;
  let previous = node.previousSibling;
  while (previous?.type === 'decorator') {
    current = previous;
    previous = previous.previousSibling;
  }
  if (previous?.type !== 'comment' || !previous.text.startsWith('/**')) return null;
  if (previous.text.startsWith('/***') || !isAttached(previous, current)) return null;
  return blockDoc(previous.text);
}

// Decorators sit inside a class node; the signature starts at the keyword.
function afterDecorators(node: Node): Node {
  return node.children.find((child) => child.type !== 'decorator') ?? node;
}

function isVisible(member: Node): boolean {
  const name = member.childForFieldName('name');
  if (name?.type === 'private_property_identifier') return false;
  const access = member.children.find((child) => child.type === 'accessibility_modifier');
  return access === undefined || access.text === 'public';
}

function methods(body: Node | null, owner: string, drafts: Draft[]): void {
  for (const member of body?.namedChildren ?? []) {
    if (!METHOD_TYPES.has(member.type)) continue;
    const name = member.childForFieldName('name');
    if (name === null) continue;
    drafts.push({
      name: `${owner}.${name.text}`,
      kind: 'method',
      signature: head(member, member.childForFieldName('body')),
      doc: docAbove(member),
      node: member,
      owner,
      visible: isVisible(member),
    });
  }
}

function constants(declaration: Node, anchor: Node, drafts: Draft[]): void {
  if (declaration.firstChild?.text !== 'const') return;
  const doc = docAbove(anchor);
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const name = declarator.childForFieldName('name');
    // Destructuring declares names whose types live elsewhere, so it is not an API item.
    if (name?.type !== 'identifier') continue;
    const value = declarator.childForFieldName('value');
    if (value !== null && FUNCTION_VALUES.has(value.type)) {
      const signature = head(value, value.childForFieldName('body'));
      drafts.push({
        name: name.text,
        kind: 'function',
        signature: `const ${name.text} = ${signature}`,
        doc,
        node: declarator,
        owner: name.text,
        visible: true,
      });
      continue;
    }
    const type = declarator.childForFieldName('type');
    drafts.push({
      name: name.text,
      kind: 'const',
      signature: `const ${name.text}${type === null ? '' : head(type, null)}`,
      doc,
      node: declarator,
      owner: name.text,
      visible: true,
    });
  }
}

function declaration(node: Node, anchor: Node, drafts: Draft[], fallback?: string): string[] {
  const name = node.childForFieldName('name')?.text ?? fallback;
  const add = (kind: SymbolKind, signature: string) => {
    if (name === undefined) return;
    drafts.push({
      name,
      kind,
      signature,
      doc: docAbove(anchor),
      node: anchor.type === 'export_statement' ? anchor : node,
      owner: name,
      visible: true,
    });
  };
  if (FUNCTION_TYPES.has(node.type)) {
    add('function', head(node, node.childForFieldName('body')));
  } else if (CLASS_TYPES.has(node.type)) {
    const body = node.childForFieldName('body');
    add('class', head(node, body, afterDecorators(node)));
    if (name !== undefined) methods(body, name, drafts);
  } else if (node.type === 'interface_declaration') {
    add('interface', head(node, node.childForFieldName('body')));
  } else if (node.type === 'enum_declaration') {
    add('enum', head(node, node.childForFieldName('body')));
  } else if (node.type === 'type_alias_declaration') {
    add('type', head(node, null));
  } else if (node.type === 'lexical_declaration') {
    constants(node, anchor, drafts);
  } else if (node.type === 'ambient_declaration') {
    const inner = node.namedChildren.find((child) => child.type !== 'comment');
    if (inner !== undefined) return declaration(inner, anchor, drafts, fallback);
  } else if (node.type === 'identifier') {
    // `export default name` exports a binding declared elsewhere in the file.
    return [node.text];
  }
  return [];
}

export function extractEcmascript(root: Node, out: Collector): void {
  const drafts: Draft[] = [];
  const exportedTop = new Set<string>();
  const exportedNames = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type !== 'export_statement') {
      declaration(node, node, drafts);
      continue;
    }
    const before = drafts.length;
    const inner = node.childForFieldName('declaration') ?? node.childForFieldName('value');
    if (inner !== null) {
      for (const name of declaration(inner, node, drafts, 'default')) exportedNames.add(name);
    }
    for (const draft of drafts.slice(before)) exportedTop.add(draft.owner);
    // `export { a, b as c }` without a source names local bindings. A re-export from another
    // module is the caller's to follow across files.
    if (node.childForFieldName('source') !== null) continue;
    for (const clause of node.namedChildren) {
      if (clause.type !== 'export_clause') continue;
      for (const specifier of clause.namedChildren) {
        const local = specifier.childForFieldName('name');
        if (local !== null) exportedNames.add(local.text);
      }
    }
  }

  for (const draft of drafts) {
    const ownerExported = exportedTop.has(draft.owner) || exportedNames.has(draft.owner);
    out.symbol({ ...draft, exported: ownerExported && draft.visible });
  }
  ecmascriptRoutes(root, out);
}
