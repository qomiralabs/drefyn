import { randomUUID } from 'node:crypto';
import { DbError } from '@drefyn/db';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { insertedRow } from './oauth-store.ts';

// The rows SSO sign in reads and writes, kept in memory behind the scripted store. It answers
// the statements Kysely compiles for sso-sign-in.ts by table and shape; the integration suite
// runs the same flows against the real schema and policies.

export type Row = Record<string, unknown>;

export interface SsoTables {
  connection: Row | null;
  // Verified domains of the connection.
  domains: string[];
  // The user id of the member who made the connection.
  creator: string | null;
  tier: string;
  readonly identities: Row[];
  readonly users: Row[];
  readonly memberships: Row[];
  readonly invitations: Row[];
  readonly email_challenges: Row[];
  // Users with a confirmed second factor.
  readonly enrolled: Set<string>;
}

// Equality filters only: "column" = $n, with or without a table alias.
function filters(s: Statement): Map<string, unknown> {
  const where = s.sql
    .split(/\bwhere\b/i)
    .slice(1)
    .join(' where ');
  return new Map(
    [...where.matchAll(/"(?:\w+"\.")?(\w+)" = \$(\d+)/g)].map((m) => [
      m[1] ?? '',
      s.parameters[Number(m[2]) - 1],
    ]),
  );
}

const has = (sql: string, text: string) => sql.includes(text);

export function ssoStore(seed: Partial<SsoTables> = {}) {
  const tables: SsoTables = {
    connection: null,
    domains: [],
    creator: null,
    tier: 'self_hosted',
    identities: [],
    users: [],
    memberships: [],
    invitations: [],
    email_challenges: [],
    enrolled: new Set(),
    ...seed,
  };
  let currentUser: string | undefined;
  const failures: ((s: Statement) => boolean)[] = [];
  // Run once, just before the first statement holding their text is answered, to play a
  // parallel request that commits in between.
  const before: { text: string; run: () => void }[] = [];
  const answers: { text: string; rows: Row[] }[] = [];

  const respond = (s: Statement): Row[] => {
    const sql = s.sql;
    const f = filters(s);
    const conn = tables.connection;
    if (has(sql, 'select o.plan_tier')) {
      const used =
        tables.memberships.length + tables.invitations.filter((i) => i['live'] !== false).length;
      return [{ plan_tier: tables.tier, used }];
    }
    if (has(sql, 'from "sso_connections" as "c"')) {
      return tables.creator !== null && f.get('user_id') === tables.creator ? [{ id: 'm' }] : [];
    }
    if (has(sql, 'from "sso_connections"')) {
      return conn !== null && f.get('id') === conn['id'] ? [conn] : [];
    }
    if (has(sql, 'from "sso_domains"')) {
      return tables.domains.includes(String(f.get('domain'))) ? [{ domain: f.get('domain') }] : [];
    }
    if (has(sql, 'update "sso_identities"')) {
      const row = tables.identities.find(
        (r) =>
          r['organization_id'] === f.get('organization_id') &&
          r['connection_id'] === f.get('connection_id') &&
          r['subject'] === f.get('subject'),
      );
      if (row === undefined) return [];
      row['last_used_at'] = new Date();
      return [row];
    }
    if (has(sql, 'insert into "sso_identities"')) {
      const row: Row = { id: randomUUID(), created_at: new Date(), ...insertedRow(s) };
      const clash = tables.identities.some(
        (r) =>
          r['organization_id'] === row['organization_id'] &&
          r['connection_id'] === row['connection_id'] &&
          (r['subject'] === row['subject'] || r['user_id'] === row['user_id']),
      );
      if (clash) {
        if (has(sql, 'on conflict do nothing')) return [];
        throw new DbError('DB_UNIQUE_VIOLATION', 'sso_identities_subject_key');
      }
      tables.identities.push(row);
      return [row];
    }
    if (has(sql, 'insert into "users"')) {
      const row: Row = insertedRow(s);
      if (tables.users.some((r) => r['email_normalized'] === row['email_normalized'])) return [];
      tables.users.push(row);
      return [row];
    }
    if (has(sql, 'from "users"')) {
      return tables.users.filter((r) => r['email_normalized'] === f.get('email_normalized'));
    }
    if (has(sql, 'from "totp_credentials"')) {
      return currentUser !== undefined && tables.enrolled.has(currentUser)
        ? [{ user_id: currentUser }]
        : [];
    }
    if (has(sql, 'delete from "invitations"')) {
      const at = tables.invitations.findIndex((r) => r['id'] === f.get('id'));
      if (at >= 0) tables.invitations.splice(at, 1);
      return [];
    }
    if (has(sql, 'from "invitations" as "i"')) {
      const found = tables.invitations.find(
        (r) => r['email_normalized'] === f.get('email_normalized') && r['live'] !== false,
      );
      return found === undefined ? [] : [found];
    }
    if (has(sql, 'from "invitations"')) {
      return tables.invitations.filter(
        (r) => r['email_normalized'] === f.get('email_normalized') && r['live'] !== false,
      );
    }
    if (has(sql, 'insert into "memberships"')) {
      const row: Row = { id: randomUUID(), ...insertedRow(s) };
      if (tables.memberships.some((r) => r['user_id'] === row['user_id'])) {
        if (has(sql, 'on conflict')) return [];
        throw new DbError('DB_UNIQUE_VIOLATION', 'memberships_organization_user_key');
      }
      tables.memberships.push(row);
      return [row];
    }
    if (has(sql, 'from "memberships"')) {
      return tables.memberships.filter((r) => r['user_id'] === f.get('user_id'));
    }
    if (has(sql, 'from "organizations"')) return [{ organization_id: f.get('organization_id') }];
    if (has(sql, 'insert into "known_devices"')) return [{ fresh: true, at: new Date() }];
    if (has(sql, 'insert into "email_challenges"')) {
      const row = insertedRow(s);
      tables.email_challenges.push(row);
      return [row];
    }
    return [];
  };

  const scripted = scriptedStore((s) => {
    if (failures.some((failing) => failing(s))) throw new Error('scripted failure');
    const hook = before.findIndex((b) => s.sql.includes(b.text));
    if (hook >= 0) before.splice(hook, 1)[0]?.run();
    const fixed = answers.find((a) => s.sql.includes(a.text));
    return fixed === undefined ? respond(s) : fixed.rows;
  });

  const store = {
    ...scripted.store,
    user: <T>(...args: Parameters<typeof scripted.store.user<T>>) => {
      currentUser = args[0];
      return scripted.store.user(...args).finally(() => {
        currentUser = undefined;
      });
    },
  };

  return {
    tables,
    scripted,
    store,
    // Fails every statement whose SQL holds this text, as a dropped connection would.
    failWhen(text: string) {
      failures.push((s) => s.sql.includes(text));
    },
    heal() {
      failures.splice(0);
    },
    // Answers every statement holding this text with these rows, whatever the tables say.
    answerWhen(text: string, rows: Row[]) {
      answers.push({ text, rows });
    },
    beforeFirst(text: string, run: () => void) {
      before.push({ text, run });
    },
    // Everything any statement sent, for the never stored checks.
    sent(): string {
      return JSON.stringify(scripted.statements().map((s) => [s.sql, s.parameters]));
    },
  };
}

export type SsoStoreFake = ReturnType<typeof ssoStore>;
