import { randomUUID } from 'node:crypto';
import { scriptedStore, type Statement } from './scripted-store.ts';

// A few tables kept in memory behind the scripted store, enough for the OAuth flows to run
// end to end without Postgres. It reads the statements Kysely compiles: insert column
// lists, equality filters on $n parameters and returning lists. The integration suite runs
// the same flows against the real schema.

export type Row = Record<string, unknown>;

const TABLE = /^\s*(select|insert into|delete from|update)\b[\s\S]*?"(\w+)"/i;

function tableOf(sql: string): { verb: string; table: string } | null {
  const verb = /^\s*(select|insert|delete|update)\b/i.exec(sql)?.[1]?.toLowerCase();
  if (verb === undefined) return null;
  const from =
    verb === 'select'
      ? /\bfrom "(\w+)"/i.exec(sql)?.[1]
      : verb === 'insert'
        ? /^\s*insert into "(\w+)"/i.exec(sql)?.[1]
        : verb === 'delete'
          ? /^\s*delete from "(\w+)"/i.exec(sql)?.[1]
          : /^\s*update "(\w+)"/i.exec(sql)?.[1];
  if (from === undefined || !TABLE.test(sql)) return null;
  return { verb, table: from };
}

// The text between the parentheses that open at index, nested ones included.
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced: ${text}`);
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const param = (s: Statement, token: string): unknown => {
  const n = /^\$(\d+)$/.exec(token.trim())?.[1];
  return n === undefined ? { expression: token.trim() } : s.parameters[Number(n) - 1];
};

export function insertedRow(s: Statement): Row {
  const columnsAt = s.sql.indexOf('(');
  const columns = splitTop(balanced(s.sql, columnsAt)).map((c) => c.replaceAll('"', ''));
  const valuesAt = s.sql.indexOf('(', s.sql.indexOf(' values '));
  const values = splitTop(balanced(s.sql, valuesAt));
  const row: Row = {};
  columns.forEach((column, i) => {
    row[column] = param(s, values[i] ?? '');
  });
  return row;
}

// Equality filters only: "column" = $n. Anything else in a where is ignored here.
function filters(s: Statement): [string, unknown][] {
  const where = s.sql
    .split(/\bwhere\b/i)
    .slice(1)
    .join(' where ');
  return [...where.matchAll(/"(?:\w+"\.")?(\w+)" = \$(\d+)/g)].map((m) => [
    m[1] ?? '',
    s.parameters[Number(m[2]) - 1],
  ]);
}

const same = (a: unknown, b: unknown) =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

export interface OAuthTables {
  readonly users: Row[];
  readonly identities: Row[];
  readonly oauth_states: Row[];
  readonly email_challenges: Row[];
  readonly password_credentials: Row[];
  readonly sessions: Row[];
}

export function oauthStore() {
  const tables: OAuthTables = {
    users: [],
    identities: [],
    oauth_states: [],
    email_challenges: [],
    password_credentials: [],
    sessions: [],
  };
  // The user context of the transaction in flight, for app.current_user_id().
  let currentUser: string | undefined;
  const failOn = new Set<string>();

  const scripted = scriptedStore((s) => {
    const shape = tableOf(s.sql);
    if (shape === null) return [];
    const { verb, table } = shape;
    if (failOn.has(`${verb} ${table}`)) throw new Error(`scripted ${verb} ${table} failure`);
    const rows = (tables as unknown as Record<string, Row[] | undefined>)[table];
    if (rows === undefined) return [];
    const scoped = (row: Row) =>
      !s.sql.includes('app.current_user_id()') || row['user_id'] === currentUser;
    const matching = () =>
      rows.filter((row) => scoped(row) && filters(s).every(([c, v]) => same(row[c], v)));

    if (verb === 'insert') {
      const row: Row = { id: randomUUID(), created_at: new Date(), ...insertedRow(s) };
      if (
        table === 'users' &&
        rows.some((r) => r['email_normalized'] === row['email_normalized'])
      ) {
        return [];
      }
      if (table === 'identities') {
        const clash = rows.some(
          (r) =>
            (r['provider'] === row['provider'] &&
              r['provider_subject'] === row['provider_subject']) ||
            (r['user_id'] === row['user_id'] && r['provider'] === row['provider']),
        );
        if (clash) return [];
      }
      if (table === 'oauth_states') row['live'] = true;
      rows.push(row);
      return [row];
    }
    if (verb === 'select') {
      const found = matching();
      if (table === 'identities' && /count\(/i.test(s.sql)) return [{ count: found.length }];
      return found;
    }
    if (verb === 'delete') {
      const gone = matching();
      for (const row of gone) rows.splice(rows.indexOf(row), 1);
      return gone;
    }
    // update
    const touched = matching();
    for (const row of touched) row['authenticated_at'] = new Date();
    return touched;
  });

  const store = {
    user: <T>(...args: Parameters<typeof scripted.store.user<T>>) => {
      currentUser = args[0];
      return scripted.store.user(...args).finally(() => {
        currentUser = undefined;
      });
    },
    auth: <T>(...args: Parameters<typeof scripted.store.auth<T>>) => scripted.store.auth(...args),
  };

  return {
    tables,
    scripted,
    store,
    // Makes every statement of this verb on this table fail, as a dropped connection would.
    fail(verb: 'select' | 'insert' | 'delete' | 'update', table: string) {
      failOn.add(`${verb} ${table}`);
    },
    // Everything any statement sent, for the never stored checks.
    sent(): string {
      return JSON.stringify(scripted.statements().map((s) => [s.sql, s.parameters]));
    },
  };
}

export type OAuthStore = ReturnType<typeof oauthStore>;
