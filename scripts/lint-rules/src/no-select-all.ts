import type { Rule } from 'eslint';
import { isRecord } from './workspace.ts';

// Kysely's selectAll() sends `select *`, and on a table whose grants are per column the
// database refuses it for every role. The schema types cannot stop the method compiling, so
// this rule refuses it at build time instead, by reading the query chain it ends.

const FROM = new Set([
  'selectFrom',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
  'innerJoinLateral',
  'leftJoinLateral',
  'crossJoinLateral',
]);

interface Options {
  readonly tables: readonly string[];
}

// String literals in an argument: 'users' or ['sessions', 'users'].
function literals(node: unknown): string[] {
  if (!isRecord(node)) return [];
  if (node['type'] === 'Literal' && typeof node['value'] === 'string') return [node['value']];
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

export const noSelectAll: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Refuse selectAll() on tables whose grants are per column' },
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
        'selectAll() on {{table}} sends select *, which the database refuses: its grants are per column. Name the columns you need.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? { tables: [] }) as Options;
    const controlled = new Set(options.tables);
    return {
      CallExpression(node) {
        const call = methodCall(node);
        if (call?.method !== 'selectAll') return;
        // Every controlled table the chain reads, under its own name and its alias.
        const seen = new Map<string, string>();
        for (
          let link = methodCall(call.receiver);
          link !== undefined;
          link = methodCall(link.receiver)
        ) {
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
        // selectAll() takes every table in the query; selectAll('t') only the ones named.
        const hit =
          asked.length === 0
            ? [...seen.values()][0]
            : asked
                .map((name) => seen.get(name) ?? (controlled.has(name) ? name : undefined))
                .find((name) => name !== undefined);
        if (hit !== undefined) {
          context.report({ node, messageId: 'selectAll', data: { table: hit } });
        }
      },
    };
  },
};
