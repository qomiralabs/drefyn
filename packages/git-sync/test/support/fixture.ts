import { randomUUID } from 'node:crypto';
import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterAll, inject } from 'vitest';
import {
  createGitSyncStore,
  databaseGitSyncDb,
  type GitSyncGate,
  type GitSyncLogger,
  type GitSyncStore,
  type LogFields,
} from '../../src/index.ts';
import { superuser, urlFor } from './stack.ts';

export const database = () => inject('gitSyncDatabase');
export const admin = (text: string) => superuser(text, database());

// Pools a file opened, closed after it even when a test fails halfway.
export function pools() {
  const open: Database[] = [];
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDatabase(db).catch(() => undefined);
  });
  return async (overrides: Readonly<Record<string, string>> = {}): Promise<Database> => {
    const db = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', database()),
        DREFYN_DATABASE_SSL: 'disable',
        ...overrides,
      }),
    );
    open.push(db);
    return db;
  };
}

export const openGate: GitSyncGate = { check: () => Promise.resolve(null) };

export interface Seeded {
  readonly tenant: TenantRef;
  readonly organization: string;
  readonly project: string;
  // Nodes with one version each, ready for the file map.
  readonly nodes: readonly { readonly node: string; readonly version: string }[];
}

// Every test gets its own organization, so files and cases never see each other's rows.
export async function seed(
  options: { readonly nodes?: number; readonly organization?: string } = {},
): Promise<Seeded> {
  const organization = options.organization ?? randomUUID();
  const project = randomUUID();
  const type = randomUUID();
  const nodes = Array.from({ length: options.nodes ?? 0 }, () => ({
    node: randomUUID(),
    version: randomUUID(),
  }));
  const organizationRow =
    options.organization === undefined
      ? `insert into app.organizations (organization_id, name, plan_tier)
           values ('${organization}', 'Org', 'self_hosted');`
      : '';
  const nodeRows = nodes
    .map(
      ({ node, version }, i) => `
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${node}', '${organization}', '${project}', 'docs_page', '${type}', 'a${String(i)}', 'draft');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, idempotency_key)
  values ('${version}', '${organization}', '${project}', '${node}', 1, 1, 1, 'human', '{}', '{}',
          decode(repeat('aa', 32), 'hex'), 'seed-${node}');`,
    )
    .join('\n');
  await admin(`
${organizationRow}
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${organization}', 'docs', 'p${project.slice(0, 8)}', 'Project');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${type}', '${organization}', '${project}', 'docs_page', 'page');
${nodeRows}
`);
  return {
    tenant: { organizationId: organizationId(organization), projectId: projectId(project) },
    organization,
    project,
    nodes,
  };
}

export interface FakeClock {
  readonly now: () => Date;
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function fakeClock(start = '2026-11-16T10:15:00.000Z'): FakeClock {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    set: (value) => {
      at = new Date(value).getTime();
    },
    advance: (ms) => {
      at += ms;
    },
  };
}

export interface RecordedLog {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields;
}

export function recordingLogger(): GitSyncLogger & { readonly lines: RecordedLog[] } {
  const lines: RecordedLog[] = [];
  return {
    lines,
    info: (event, fields) => lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
  };
}

export function storeOver(
  db: Database,
  options: {
    readonly clock?: FakeClock;
    readonly gate?: GitSyncGate;
    readonly logger?: GitSyncLogger;
    readonly maxFiles?: number;
  } = {},
): GitSyncStore {
  return createGitSyncStore({
    db: databaseGitSyncDb(db),
    gate: options.gate ?? openGate,
    ...(options.clock === undefined ? {} : { clock: options.clock.now }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
}

export const BINDING = {
  installationId: 41,
  repository: { owner: 'acme', name: 'docs', id: 7001 },
  branch: 'main',
  folder: 'docs',
} as const;

export const sha = (n: number) => n.toString(16).padStart(40, '0');

// Asserts a result is ok and gives its value, so a test reads as the happy path.
export function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}
