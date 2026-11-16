import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { blockDoc, head, isAttached, lineDoc } from '../text.ts';
import type { SymbolKind } from '../types.ts';
import { goRoutes } from './go-routes.ts';

// Exported in Go means a leading upper case letter, in any script.
const isExported = (name: string) => /^\p{Lu}/u.test(name);
// Tool directives such as //go:generate are not prose.
const DIRECTIVE = /^\/\/[a-z0-9]+:\S/;

function docAbove(node: Node): string | null {
  const lines: string[] = [];
  let below = node;
  let comment = node.previousSibling;
  while (comment?.type === 'comment' && isAttached(comment, below)) {
    if (comment.text.startsWith('/*')) {
      if (lines.length > 0) break;
      return blockDoc(comment.text.replace(/^\/\*/, '/**'));
    }
    if (!DIRECTIVE.test(comment.text)) lines.unshift(comment.text);
    below = comment;
    comment = comment.previousSibling;
  }
  return lines.length === 0 ? null : lineDoc(lines, '//');
}

// A spec inside `const ( ... )` or `type ( ... )` carries its own comment; a lone one has it
// above the keyword.
function specDoc(spec: Node, declaration: Node): string | null {
  const grouped = declaration.children.some((child) => child.type === '(');
  return docAbove(grouped ? spec : declaration);
}

// The receiver's type name: `Client` in `(c *Client)` and `page` in `(p page[T])`.
function receiverType(method: Node): string | undefined {
  let type = method.childForFieldName('receiver')?.firstNamedChild?.childForFieldName('type');
  while (type !== null && type !== undefined && type.type !== 'type_identifier') {
    type = type.type === 'pointer_type' ? type.firstNamedChild : type.childForFieldName('type');
  }
  return type?.text;
}

function typeSpec(spec: Node, declaration: Node, out: Collector): void {
  const name = spec.childForFieldName('name')?.text;
  const type = spec.childForFieldName('type');
  if (name === undefined || type === null) return;
  let kind: SymbolKind = 'type';
  let signature = `type ${head(spec, null)}`;
  if (
    spec.type === 'type_spec' &&
    (type.type === 'struct_type' || type.type === 'interface_type')
  ) {
    kind = type.type === 'struct_type' ? 'struct' : 'interface';
    signature = `type ${head(spec, type)} ${kind}`;
  }
  out.symbol({
    name,
    kind,
    exported: isExported(name),
    signature,
    doc: specDoc(spec, declaration),
    node: spec,
  });
}

function constSpec(spec: Node, declaration: Node, out: Collector): void {
  const type = spec.childForFieldName('type');
  for (const name of spec.childrenForFieldName('name')) {
    if (name.text === '_') continue;
    out.symbol({
      name: name.text,
      kind: 'const',
      exported: isExported(name.text),
      signature: `const ${name.text}${type === null ? '' : ` ${head(type, null)}`}`,
      doc: specDoc(spec, declaration),
      node: spec,
    });
  }
}

export function extractGo(root: Node, out: Collector): void {
  for (const node of root.namedChildren) {
    const name = node.childForFieldName('name')?.text;
    if (node.type === 'function_declaration' && name !== undefined) {
      out.symbol({
        name,
        kind: 'function',
        exported: isExported(name),
        signature: head(node, node.childForFieldName('body')),
        doc: docAbove(node),
        node,
      });
    } else if (node.type === 'method_declaration' && name !== undefined) {
      const owner = receiverType(node);
      if (owner === undefined) continue;
      out.symbol({
        name: `${owner}.${name}`,
        kind: 'method',
        exported: isExported(name) && isExported(owner),
        signature: head(node, node.childForFieldName('body')),
        doc: docAbove(node),
        node,
      });
    } else if (node.type === 'type_declaration') {
      for (const spec of node.namedChildren) {
        if (spec.type === 'type_spec' || spec.type === 'type_alias') typeSpec(spec, node, out);
      }
    } else if (node.type === 'const_declaration') {
      for (const spec of node.namedChildren) {
        if (spec.type === 'const_spec') constSpec(spec, node, out);
      }
    }
  }
  goRoutes(root, out);
}
