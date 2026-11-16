import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { literalText } from '../text.ts';

const METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
  'any',
]);

function frameworks(root: Node): Set<string> {
  const found = new Set<string>();
  for (const use of root.descendantsOfType('use_declaration')) {
    const crate = use.childForFieldName('argument')?.text.split('::')[0]?.split('{')[0];
    if (crate === 'axum') found.add('axum');
    if (crate === 'actix_web') found.add('actix-web');
    if (crate === 'rocket') found.add('rocket');
  }
  return found;
}

const lastSegment = (node: Node | null): string | undefined =>
  node?.type === 'identifier' ? node.text : node?.childForFieldName('name')?.text;

// `get(a).post(b)` or `axum::routing::delete(c)`, read from the outside in.
function methodRouter(node: Node | undefined): string[] | undefined {
  if (node?.type !== 'call_expression') return undefined;
  const callee = node.childForFieldName('function');
  if (callee?.type === 'field_expression') {
    const method = callee.childForFieldName('field')?.text ?? '';
    const before = methodRouter(callee.childForFieldName('value') ?? undefined);
    return before === undefined || !METHODS.has(method) ? undefined : [...before, method];
  }
  const method = lastSegment(callee);
  return method !== undefined && METHODS.has(method) ? [method] : undefined;
}

function axumRoutes(root: Node, out: Collector): void {
  // A builder chain nests the last call outermost, so calls are put back in source order.
  const found: [number, Node, Node | undefined][] = [];
  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (callee?.type !== 'field_expression') continue;
    if (callee.childForFieldName('field')?.text !== 'route') continue;
    const [path, router] = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (path !== undefined) found.push([path.startIndex, path, router]);
  }
  found.sort((a, b) => a[0] - b[0]);
  for (const [, path, router] of found) {
    const route = literalText(path);
    const methods = methodRouter(router);
    if (route === undefined || methods === undefined) {
      out.partial = true;
      continue;
    }
    for (const method of methods) out.route(method === 'any' ? 'ANY' : method, route, 'axum');
  }
}

// `#[get("/x")]` on a handler, the actix-web and Rocket way.
function attributeRoutes(root: Node, framework: string, out: Collector): void {
  for (const attribute of root.descendantsOfType('attribute')) {
    const name = attribute.firstNamedChild;
    if (name?.type !== 'identifier') continue;
    if (name.text === 'route') {
      out.partial = true;
      continue;
    }
    if (!METHODS.has(name.text) || name.text === 'any') continue;
    const route = literalText(attribute.childForFieldName('arguments')?.namedChildren[0]);
    if (route === undefined) out.partial = true;
    else out.route(name.text, route, framework);
  }
}

export function rustRoutes(root: Node, out: Collector): void {
  const found = frameworks(root);
  // Routes are calls in axum, so they are traversed once, in source order.
  if (found.has('axum')) axumRoutes(root, out);
  if (found.has('actix-web')) attributeRoutes(root, 'actix-web', out);
  else if (found.has('rocket')) attributeRoutes(root, 'rocket', out);
}
