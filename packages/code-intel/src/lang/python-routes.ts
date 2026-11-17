import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { literalText } from '../text.ts';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const APP_FACTORIES: Readonly<Record<string, string>> = {
  Flask: 'flask',
  Blueprint: 'flask',
  FastAPI: 'fastapi',
  APIRouter: 'fastapi',
};
const CONVENTIONAL = ['app', 'router', 'bp', 'blueprint', 'api'];

function importedModules(root: Node): Set<string> {
  const modules = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type === 'import_from_statement') {
      const name = node.childForFieldName('module_name')?.text;
      if (name !== undefined) modules.add(name);
    } else if (node.type === 'import_statement') {
      for (const name of node.namedChildren) modules.add(name.text.split(' ')[0] ?? '');
    }
  }
  return modules;
}

const argumentsOf = (call: Node): Node[] =>
  (call.childForFieldName('arguments')?.namedChildren ?? []).filter(
    (child) => child.type !== 'comment',
  );

function keyword(call: Node, name: string): Node | undefined {
  return (
    argumentsOf(call)
      .find(
        (argument) =>
          argument.type === 'keyword_argument' && argument.childForFieldName('name')?.text === name,
      )
      ?.childForFieldName('value') ?? undefined
  );
}

// Variables made from a framework class: `app = Flask(__name__)`, `router = APIRouter()`.
function appBindings(root: Node, fallback: string): Map<string, string> {
  const bindings = new Map<string, string>(CONVENTIONAL.map((name) => [name, fallback]));
  for (const assignment of root.descendantsOfType('assignment')) {
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const callee = right.childForFieldName('function')?.text.split('.').pop() ?? '';
    const framework = APP_FACTORIES[callee];
    if (framework !== undefined) bindings.set(left.text, framework);
  }
  return bindings;
}

function decoratorRoute(call: Node, bindings: ReadonlyMap<string, string>, out: Collector): void {
  const callee = call.childForFieldName('function');
  if (callee?.type !== 'attribute') return;
  const object = callee.childForFieldName('object');
  const attribute = callee.childForFieldName('attribute')?.text ?? '';
  const framework = object?.type === 'identifier' ? bindings.get(object.text) : undefined;
  if (framework === undefined || (attribute !== 'route' && !METHODS.has(attribute))) return;
  const route = literalText(argumentsOf(call)[0]);
  if (route === undefined) {
    out.partial = true;
    return;
  }
  if (attribute !== 'route') {
    out.route(attribute, route, framework);
    return;
  }
  const listed = keyword(call, 'methods');
  if (listed === undefined) {
    out.route('GET', route, framework);
    return;
  }
  const methods =
    listed.type === 'list' || listed.type === 'tuple'
      ? listed.namedChildren.map(literalText)
      : [undefined];
  if (methods.includes(undefined)) out.partial = true;
  for (const method of methods) if (method !== undefined) out.route(method, route, framework);
}

export function pythonRoutes(root: Node, out: Collector): void {
  const modules = importedModules(root);
  const flask = [...modules].some((name) => name === 'flask' || name.startsWith('flask.'));
  const fastapi = [...modules].some((name) => name === 'fastapi' || name.startsWith('fastapi.'));
  if (flask || fastapi) {
    const bindings = appBindings(root, fastapi ? 'fastapi' : 'flask');
    for (const decorator of root.descendantsOfType('decorator')) {
      const call = decorator.firstNamedChild;
      if (call?.type === 'call') decoratorRoute(call, bindings, out);
    }
  }
  if (!modules.has('django.urls')) return;
  for (const call of root.descendantsOfType('call')) {
    const callee = call.childForFieldName('function');
    if (callee?.type !== 'identifier') continue;
    if (callee.text !== 'path' && callee.text !== 're_path') continue;
    const route = literalText(argumentsOf(call)[0]);
    if (route === undefined) out.partial = true;
    else out.route('ANY', route, 'django');
  }
}
