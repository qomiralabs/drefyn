import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { blockDoc, head, isAttached, lineDoc } from '../text.ts';
import type { SymbolKind } from '../types.ts';
import { rustRoutes } from './rust-routes.ts';

interface Scope {
  // Prefix for items in inline modules: `auth.` for `mod auth { ... }`.
  readonly prefix: string;
  // False inside a private module, where even `pub` items are out of reach.
  readonly reachable: boolean;
}

// Only bare `pub` reaches outside the crate; `pub(crate)` and `pub(super)` do not.
const isPub = (node: Node) =>
  node.children.some((child) => child.type === 'visibility_modifier' && child.text === 'pub');

function docAbove(node: Node): string | null {
  const lines: string[] = [];
  let below = node;
  let previous = node.previousSibling;
  while (previous !== null) {
    if (previous.type === 'attribute_item') {
      below = previous;
      previous = previous.previousSibling;
      continue;
    }
    if (!isAttached(previous, below)) break;
    const text = previous.text;
    if (previous.type === 'line_comment' && text.startsWith('///') && !text.startsWith('////')) {
      lines.unshift(text.trimEnd());
    } else if (
      previous.type === 'block_comment' &&
      lines.length === 0 &&
      /^\/\*\*[^*/]/.test(text)
    ) {
      return blockDoc(text);
    } else break;
    below = previous;
    previous = previous.previousSibling;
  }
  return lines.length === 0 ? null : lineDoc(lines, '///');
}

// The type an inherent impl block is for: `Client` in `impl<T> Client<T>`.
function implType(node: Node): string | undefined {
  let type = node.childForFieldName('type');
  while (type !== null && type.type !== 'type_identifier') {
    type = type.childForFieldName('name') ?? type.childForFieldName('type');
  }
  return type?.text;
}

const ITEMS: Readonly<Record<string, SymbolKind>> = {
  function_item: 'function',
  function_signature_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  type_item: 'type',
  const_item: 'const',
  static_item: 'const',
};

function signatureOf(node: Node): string {
  switch (node.type) {
    case 'function_item':
    case 'enum_item':
    case 'trait_item':
      return head(node, node.childForFieldName('body'));
    case 'struct_item': {
      const body = node.childForFieldName('body');
      // A tuple struct's fields are its shape; a braced body is not part of the head.
      return head(node, body?.type === 'field_declaration_list' ? body : null);
    }
    case 'const_item':
    case 'static_item':
      return head(node, node.childForFieldName('value'));
    default:
      return head(node, null);
  }
}

function members(
  body: Node | null,
  owner: string,
  exported: (item: Node) => boolean,
  out: Collector,
) {
  for (const item of body?.namedChildren ?? []) {
    if (item.type !== 'function_item' && item.type !== 'function_signature_item') continue;
    const name = item.childForFieldName('name')?.text;
    if (name === undefined) continue;
    out.symbol({
      name: `${owner}.${name}`,
      kind: 'method',
      exported: exported(item),
      signature: signatureOf(item),
      doc: docAbove(item),
      node: item,
    });
  }
}

function items(container: Node, scope: Scope, out: Collector): void {
  for (const node of container.namedChildren) {
    const name = node.childForFieldName('name')?.text;
    const kind = ITEMS[node.type];
    if (kind !== undefined && name !== undefined) {
      const exported = scope.reachable && isPub(node);
      out.symbol({
        name: `${scope.prefix}${name}`,
        kind,
        exported,
        signature: signatureOf(node),
        doc: docAbove(node),
        node,
      });
      // A trait's methods are as public as the trait.
      if (node.type === 'trait_item') {
        members(node.childForFieldName('body'), `${scope.prefix}${name}`, () => exported, out);
      }
    } else if (node.type === 'impl_item' && node.childForFieldName('trait') === null) {
      const owner = implType(node);
      if (owner === undefined) continue;
      const body = node.childForFieldName('body');
      members(body, `${scope.prefix}${owner}`, (item) => scope.reachable && isPub(item), out);
    } else if (node.type === 'mod_item' && name !== undefined) {
      const body = node.childForFieldName('body');
      if (body === null) continue;
      items(
        body,
        { prefix: `${scope.prefix}${name}.`, reachable: scope.reachable && isPub(node) },
        out,
      );
    } else if (node.type === 'macro_invocation') {
      // An item level macro can declare anything, and its expansion is not read.
      out.partial = true;
    }
  }
}

export function extractRust(root: Node, out: Collector): void {
  items(root, { prefix: '', reachable: true }, out);
  rustRoutes(root, out);
}
