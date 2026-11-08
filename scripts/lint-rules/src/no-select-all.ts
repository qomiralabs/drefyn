import type { Rule, Scope } from 'eslint';
import { literal } from './references.ts';
import { isRecord } from './workspace.ts';

// Kysely's selectAll() sends `select *` and returningAll() sends `returning *`. On a table whose
// grants are per column, both fail for a role missing a column, and where a role holds every
// column they would read one granted later. The schema types cannot stop the methods
// compiling, so this rule refuses them at build time instead, by reading the query they end,
// through local variables too. Parameters, helper results, table names held in
// variables and templates with a placeholder are out of its reach; the tests pin those limits.

const FROM = new Set([
  'selectFrom',
  'updateTable',
  'insertInto',
  'replaceInto',
  'deleteFrom',
  'mergeInto',
  'from',
  'using',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
  'innerJoinLateral',
  'leftJoinLateral',
  'crossJoinLateral',
]);

const ALL = new Set(['selectAll', 'returningAll']);
// Wrappers that leave the query as it is at run time.
const TRANSPARENT = new Set([
  'ChainExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

interface Options {
  readonly tables: readonly string[];
}

// String literals in an argument: 'users', `users` or ['sessions', 'users'].
function literals(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const text = literal(node)?.spec;
  if (text !== undefined) return [text];
  const elements = node['elements'];
  if (node['type'] === 'ArrayExpression' && Array.isArray(elements)) {
    return elements.flatMap((element: unknown) => literals(element));
  }
  return [];
}

// "app.users as u" names the table users and the alias u. Split on whitespace, never a regex
// around "as": table names are source text, and an overlapping pattern backtracks without
// bound on a long run of spaces. Any shape other than "table" or "table as alias" is kept
// whole, so it names no table.
function nameAndAlias(text: string): { table: string; alias: string } {
  const tokens = text.trim().split(/\s+/);
  const [first = '', middle = '', last = ''] = tokens;
  if (tokens.length === 1) {
    const bare = first.replace(/^app\./, '');
    return { table: bare, alias: bare };
  }
  if (tokens.length === 3 && middle.toLowerCase() === 'as') {
    return { table: first.replace(/^app\./, ''), alias: last };
  }
  const whole = text.trim().replace(/^app\./, '');
  return { table: whole, alias: whole };
}

interface MethodCall {
  readonly method: string;
  readonly receiver: unknown;
  readonly firstArgument: unknown;
}

// receiver.method(firstArgument, ...) with a plain, non computed method name.
function methodCall(node: unknown): MethodCall | undefined {
  if (!isRecord(node) || node['type'] !== 'CallExpression') return undefined;
  const callee = node['callee'];
  if (!isRecord(callee) || callee['type'] !== 'MemberExpression' || callee['computed'] === true) {
    return undefined;
  }
  const property = callee['property'];
  if (!isRecord(property) || property['type'] !== 'Identifier') return undefined;
  const name = property['name'];
  const args = node['arguments'];
  if (typeof name !== 'string' || !Array.isArray(args)) return undefined;
  return { method: name, receiver: callee['object'], firstArgument: args[0] as unknown };
}

function unwrap(node: unknown): unknown {
  let current = node;
  while (
    isRecord(current) &&
    typeof current['type'] === 'string' &&
    TRANSPARENT.has(current['type'])
  ) {
    current = current['expression'];
  }
  return current;
}

function variableNamed(scope: Scope.Scope | null, name: string): Scope.Variable | undefined {
  for (let current = scope; current !== null; current = current.upper) {
    const found = current.set.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Every method call that fed this query, following local variables through each value written
// to them, because a query is often built up over several statements. The seen set is the
// bound: each node is read once, so a loop of names ends.
function linksOf(start: unknown, scope: Scope.Scope): MethodCall[] {
  const links: MethodCall[] = [];
  const seen = new Set<unknown>();
  const queue = [start];
  while (queue.length > 0) {
    const node = unwrap(queue.pop());
    if (seen.has(node)) continue;
    seen.add(node);
    const call = methodCall(node);
    if (call !== undefined) {
      links.push(call);
      queue.push(call.receiver);
    } else if (isRecord(node) && node['type'] === 'Identifier') {
      const variable = variableNamed(scope, String(node['name']));
      for (const reference of variable?.references ?? []) {
        if (reference.writeExpr !== undefined && reference.writeExpr !== null) {
          queue.push(reference.writeExpr);
        }
      }
    }
  }
  return links;
}

export const noSelectAll: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Refuse selectAll() and returningAll() on tables whose grants are per column',
    },
    schema: [
      {
        type: 'object',
        properties: { tables: { type: 'array', items: { type: 'string' } } },
        required: ['tables'],
        additionalProperties: false,
      },
    ],
    messages: {
      selectAll:
        'selectAll() on {{table}} sends select *, which fails for a role missing a column and reads any column granted later: its grants are per column. Name the columns you need.',
      returningAll:
        'returningAll() on {{table}} sends returning *, which fails for a role missing a column and reads any column granted later: its grants are per column. Name the columns you need.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? { tables: [] }) as Options;
    const controlled = new Set(options.tables);
    return {
      CallExpression(node) {
        const call = methodCall(node);
        if (call === undefined || !ALL.has(call.method)) return;
        // Every controlled table the query reads, under its own name and its alias.
        const seen = new Map<string, string>();
        for (const link of linksOf(call.receiver, context.sourceCode.getScope(node))) {
          if (!FROM.has(link.method)) continue;
          for (const text of literals(link.firstArgument)) {
            const { table, alias } = nameAndAlias(text);
            if (controlled.has(table)) {
              seen.set(table, table);
              seen.set(alias, table);
            }
          }
        }
        const asked = literals(call.firstArgument);
        // With no argument it takes every table in the query; with one, only those named.
        const hit =
          asked.length === 0
            ? [...seen.values()][0]
            : asked
                .map((name) => seen.get(name) ?? (controlled.has(name) ? name : undefined))
                .find((name) => name !== undefined);
        if (hit !== undefined) {
          context.report({
            node,
            messageId: call.method === 'selectAll' ? 'selectAll' : 'returningAll',
            data: { table: hit },
          });
        }
      },
    };
  },
};
