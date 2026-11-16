import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { literalText } from '../text.ts';

const FRAMEWORKS: readonly (readonly [prefix: string, framework: string])[] = [
  ['github.com/gin-gonic/gin', 'gin'],
  ['github.com/labstack/echo', 'echo'],
  ['github.com/go-chi/chi', 'chi'],
  ['net/http', 'net/http'],
];
const UPPER = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any']);
const TITLE = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options']);
const HANDLE = new Set(['HandleFunc', 'Handle']);
// Go 1.22 patterns may lead with a method: "GET /users/{id}".
const PATTERN = /^([A-Z]+) +(\S.*)$/;

function frameworks(root: Node): Set<string> {
  const found = new Set<string>();
  for (const spec of root.descendantsOfType('import_spec')) {
    const path = literalText(spec.childForFieldName('path'));
    if (path === undefined) continue;
    const match = FRAMEWORKS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (match !== undefined) found.add(match[1]);
  }
  return found;
}

function frameworkFor(
  method: string,
  operand: string,
  found: ReadonlySet<string>,
): string | undefined {
  if (HANDLE.has(method)) {
    if (operand !== 'http' && found.has('chi')) return 'chi';
    return found.has('net/http') ? 'net/http' : undefined;
  }
  if (TITLE.has(method)) return found.has('chi') ? 'chi' : undefined;
  if (UPPER.has(method)) return found.has('gin') ? 'gin' : found.has('echo') ? 'echo' : undefined;
  return undefined;
}

export function goRoutes(root: Node, out: Collector): void {
  const found = frameworks(root);
  if (found.size === 0) return;
  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (callee?.type !== 'selector_expression') continue;
    const method = callee.childForFieldName('field')?.text ?? '';
    const operand = callee.childForFieldName('operand')?.text ?? '';
    const framework = frameworkFor(method, operand, found);
    if (framework === undefined) continue;
    const first = call
      .childForFieldName('arguments')
      ?.namedChildren.find((arg) => arg.type !== 'comment');
    const route = literalText(first);
    if (route === undefined) {
      out.partial = true;
      continue;
    }
    if (!HANDLE.has(method)) {
      out.route(method === 'Any' ? 'ANY' : method, route, framework);
      continue;
    }
    const pattern = PATTERN.exec(route);
    out.route(pattern?.[1] ?? 'ANY', pattern?.[2] ?? route, framework);
  }
}
