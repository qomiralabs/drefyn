import { withTenant, type Database, type TenantSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import type { GitSyncStoreErrorCode } from './errors.ts';
import { isPathInFolder, parseFolder } from './folder.ts';
import type { GitSyncGate } from './gate.ts';
import {
  bindingInputSchema,
  deliveryInputSchema,
  fileEntrySchema,
  stateCodeSchema,
  uuid,
  type DeliveryInput,
} from './input.ts';
import { bindingLockKey } from './lock.ts';
import {
  BINDING_STATES,
  err,
  noopLogger,
  ok,
  tenantFields,
  type BindingState,
  type ClaimedDelivery,
  type GitBinding,
  type GitFileEntry,
  type GitSyncLogger,
  type Result,
} from './types.ts';

export type GitSyncTx = Transaction<TenantSchema>;

export interface GitSyncDb {
  tenant<T>(
    tenant: TenantRef,
    work: (tx: GitSyncTx) => Promise<T>,
    options?: { readonly deadlineMs?: number },
  ): Promise<T>;
}

export const databaseGitSyncDb = (db: Database): GitSyncDb => ({
  tenant: (tenant, work, options) => withTenant(db, tenant, work, options),
});

// The default cap on docs files in one bound folder, as the convergence reads the whole map.
export const DEFAULT_MAX_FILES = 2000;
// Queued deliveries kept per binding. The claim only ever runs the newest, so past this the
// oldest are finished at once and the queue cannot grow without bound.
export const MAX_QUEUED_PER_BINDING = 100;
// How long a claim may hold its transaction, and with it the binding's lock.
export const DEFAULT_CLAIM_DEADLINE_MS = 120_000;

export interface GitSyncStoreDeps {
  readonly db: GitSyncDb;
  readonly gate: GitSyncGate;
  readonly logger?: GitSyncLogger;
  // Stamps received_at, so tests decide what newest means.
  readonly clock?: () => Date;
  readonly maxFiles?: number;
}

export type ClaimOutcome = 'done' | 'failed';

export interface ClaimResult {
  // null when the binding had nothing queued.
  readonly claimed: ClaimedDelivery | null;
  readonly outcome: ClaimOutcome | null;
  // Older queued deliveries this claim finished without running.
  readonly superseded: number;
}

export interface GitSyncStore {
  createBinding(
    tenant: TenantRef,
    input: unknown,
  ): Promise<Result<GitBinding, GitSyncStoreErrorCode>>;
  // The project's binding, or null when it has none.
  getBinding(tenant: TenantRef): Promise<Result<GitBinding | null, GitSyncStoreErrorCode>>;
  pauseBinding(
    tenant: TenantRef,
    bindingId: string,
    code: string,
  ): Promise<Result<GitBinding, GitSyncStoreErrorCode>>;
  listFiles(
    tenant: TenantRef,
    bindingId: string,
  ): Promise<Result<readonly GitFileEntry[], GitSyncStoreErrorCode>>;
  upsertFiles(
    tenant: TenantRef,
    bindingId: string,
    files: readonly unknown[],
  ): Promise<Result<{ readonly written: number }, GitSyncStoreErrorCode>>;
  // stored is false when this delivery id was already queued or run for the tenant.
  enqueueDelivery(
    tenant: TenantRef,
    input: DeliveryInput,
  ): Promise<Result<{ readonly stored: boolean }, GitSyncStoreErrorCode>>;
  // Holds the binding's lock for the whole of work, so one worker runs a binding at a time.
  // A throw from work rolls everything back and leaves the deliveries queued.
  claimDelivery(
    tenant: TenantRef,
    bindingId: string,
    work: (delivery: ClaimedDelivery) => Promise<ClaimOutcome>,
    options?: { readonly deadlineMs?: number },
  ): Promise<Result<ClaimResult, GitSyncStoreErrorCode>>;
}

interface BindingRow {
  readonly id: string;
  readonly installation_id: number;
  readonly repository_id: number;
  readonly owner: string;
  readonly name: string;
  readonly branch: string;
  readonly folder: string;
  readonly last_synced_commit: string | null;
  readonly state: string;
  readonly state_code: string | null;
}

const BINDING_COLUMNS = [
  'id',
  'installation_id',
  'repository_id',
  'owner',
  'name',
  'branch',
  'folder',
  'last_synced_commit',
  'state',
  'state_code',
] as const;

const STATES: ReadonlySet<string> = new Set(BINDING_STATES);

function bindingOf(tenant: TenantRef, row: BindingRow): GitBinding {
  // The column check holds the same three values, so anything else is a broken database.
  if (!STATES.has(row.state)) throw new Error(`git_bindings.state holds an unknown value`);
  return {
    id: row.id,
    tenant,
    installationId: row.installation_id,
    repository: { owner: row.owner, name: row.name, id: row.repository_id },
    branch: row.branch,
    folder: row.folder,
    lastSyncedCommit: row.last_synced_commit,
    state: row.state as BindingState,
    stateCode: row.state_code,
  };
}

const scoped = (tenant: TenantRef) => ({
  organization_id: tenant.organizationId,
  project_id: tenant.projectId,
});

function findBinding(tx: GitSyncTx, tenant: TenantRef, bindingId: string) {
  return tx
    .selectFrom('git_bindings')
    .select(BINDING_COLUMNS)
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', bindingId)
    .executeTakeFirst();
}

export function createGitSyncStore(deps: GitSyncStoreDeps): GitSyncStore {
  const { db, gate } = deps;
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;

  const gated = async <T>(
    tenant: TenantRef,
    work: () => Promise<Result<T, GitSyncStoreErrorCode>>,
  ): Promise<Result<T, GitSyncStoreErrorCode>> => {
    const refusal = await gate.check(tenant);
    return refusal === null ? work() : err(refusal);
  };

  return {
    createBinding: (tenant, input) =>
      gated(tenant, async () => {
        const parsed = bindingInputSchema.safeParse(input);
        if (!parsed.success) return err('git_sync.input_invalid');
        const folder = parseFolder(parsed.data.folder);
        if (!folder.ok) return err(folder.error);
        const { installationId, repository, branch } = parsed.data;
        const row = await db.tenant(tenant, (tx) =>
          tx
            .insertInto('git_bindings')
            .values({
              ...scoped(tenant),
              installation_id: installationId,
              repository_id: repository.id,
              owner: repository.owner,
              name: repository.name,
              branch,
              folder: folder.value,
            })
            .onConflict((conflict) => conflict.constraint('git_bindings_project_key').doNothing())
            .returning(BINDING_COLUMNS)
            .executeTakeFirst(),
        );
        if (row === undefined) return err('git_sync.binding_exists');
        logger.info('git_sync.binding_created', { ...tenantFields(tenant), binding_id: row.id });
        return ok(bindingOf(tenant, row));
      }),

    getBinding: (tenant) =>
      gated(tenant, async () => {
        const row = await db.tenant(tenant, (tx) =>
          tx
            .selectFrom('git_bindings')
            .select(BINDING_COLUMNS)
            .where('organization_id', '=', tenant.organizationId)
            .where('project_id', '=', tenant.projectId)
            .executeTakeFirst(),
        );
        return ok(row === undefined ? null : bindingOf(tenant, row));
      }),

    pauseBinding: (tenant, bindingId, code) =>
      gated(tenant, async () => {
        if (!uuid.safeParse(bindingId).success || !stateCodeSchema.safeParse(code).success) {
          return err('git_sync.input_invalid');
        }
        const row = await db.tenant(tenant, (tx) =>
          tx
            .updateTable('git_bindings')
            .set({ state: 'paused', state_code: code, updated_at: sql<Date>`now()` })
            .where('organization_id', '=', tenant.organizationId)
            .where('project_id', '=', tenant.projectId)
            .where('id', '=', bindingId)
            .returning(BINDING_COLUMNS)
            .executeTakeFirst(),
        );
        if (row === undefined) return err('git_sync.binding_not_found');
        logger.info('git_sync.binding_paused', {
          ...tenantFields(tenant),
          binding_id: bindingId,
          code,
        });
        return ok(bindingOf(tenant, row));
      }),

    listFiles: (tenant, bindingId) =>
      gated(tenant, async () => {
        if (!uuid.safeParse(bindingId).success) return err('git_sync.input_invalid');
        const rows = await db.tenant(tenant, async (tx) => {
          if ((await findBinding(tx, tenant, bindingId)) === undefined) return null;
          return (
            tx
              .selectFrom('git_files')
              .select(['path', 'node_id', 'blob_sha', 'synced_version_id'])
              .where('organization_id', '=', tenant.organizationId)
              .where('project_id', '=', tenant.projectId)
              .where('binding_id', '=', bindingId)
              .orderBy('path')
              // One past the cap, so a map that grew past it is refused rather than cut short.
              .limit(maxFiles + 1)
              .execute()
          );
        });
        if (rows === null) return err('git_sync.binding_not_found');
        if (rows.length > maxFiles) return err('git_sync.too_many_files');
        return ok(
          rows.map((row) => ({
            path: row.path,
            nodeId: row.node_id,
            blobSha: row.blob_sha,
            syncedVersionId: row.synced_version_id,
          })),
        );
      }),

    upsertFiles: (tenant, bindingId, files) =>
      gated(tenant, async () => {
        if (!uuid.safeParse(bindingId).success) return err('git_sync.input_invalid');
        if (files.length > maxFiles) return err('git_sync.too_many_files');
        const entries: GitFileEntry[] = [];
        for (const file of files) {
          const parsed = fileEntrySchema.safeParse(file);
          if (!parsed.success) return err('git_sync.input_invalid');
          entries.push(parsed.data);
        }
        return db.tenant(
          tenant,
          async (tx): Promise<Result<{ written: number }, GitSyncStoreErrorCode>> => {
            const binding = await findBinding(tx, tenant, bindingId);
            if (binding === undefined) return err('git_sync.binding_not_found');
            if (!entries.every((entry) => isPathInFolder(entry.path, binding.folder))) {
              return err('git_sync.path_outside_folder');
            }
            if (entries.length === 0) return ok({ written: 0 });
            await tx
              .insertInto('git_files')
              .values(
                entries.map((entry) => ({
                  ...scoped(tenant),
                  binding_id: bindingId,
                  path: entry.path,
                  node_id: entry.nodeId,
                  blob_sha: entry.blobSha,
                  synced_version_id: entry.syncedVersionId,
                })),
              )
              .onConflict((conflict) =>
                conflict.constraint('git_files_pkey').doUpdateSet({
                  node_id: (eb) => eb.ref('excluded.node_id'),
                  blob_sha: (eb) => eb.ref('excluded.blob_sha'),
                  synced_version_id: (eb) => eb.ref('excluded.synced_version_id'),
                  updated_at: sql<Date>`now()`,
                }),
              )
              .execute();
            logger.info('git_sync.files_written', {
              ...tenantFields(tenant),
              binding_id: bindingId,
              count: entries.length,
            });
            return ok({ written: entries.length });
          },
        );
      }),

    enqueueDelivery: (tenant, input) =>
      gated(tenant, async () => {
        const parsed = deliveryInputSchema.safeParse(input);
        if (!parsed.success) return err('git_sync.input_invalid');
        const { bindingId, deliveryId, headSha } = parsed.data;
        const receivedAt = clock();
        const stored = await db.tenant(tenant, async (tx) => {
          if ((await findBinding(tx, tenant, bindingId)) === undefined) return null;
          const inserted = await tx
            .insertInto('git_deliveries')
            .values({
              ...scoped(tenant),
              binding_id: bindingId,
              delivery_id: deliveryId,
              head_sha: headSha,
              received_at: receivedAt,
            })
            .onConflict((conflict) =>
              conflict.constraint('git_deliveries_delivery_key').doNothing(),
            )
            .returning('id')
            .executeTakeFirst();
          if (inserted === undefined) return false;
          await sql`
            update app.git_deliveries set state = 'done', finished_at = now()
             where id in (
               select id from app.git_deliveries
                where organization_id = ${tenant.organizationId}
                  and project_id = ${tenant.projectId}
                  and binding_id = ${bindingId} and state = 'queued'
                order by received_at desc, id desc
               offset ${MAX_QUEUED_PER_BINDING}
                  for update skip locked)`.execute(tx);
          return true;
        });
        if (stored === null) return err('git_sync.binding_not_found');
        logger.info(stored ? 'git_sync.delivery_queued' : 'git_sync.delivery_duplicate', {
          ...tenantFields(tenant),
          binding_id: bindingId,
          delivery_id: deliveryId,
        });
        return ok({ stored });
      }),

    claimDelivery: (tenant, bindingId, work, options) =>
      gated(tenant, async () => {
        if (!uuid.safeParse(bindingId).success) return err('git_sync.input_invalid');
        const key = bindingLockKey(tenant, bindingId).toString();
        const started = performance.now();
        const result = await db.tenant(
          tenant,
          async (tx): Promise<Result<ClaimResult, GitSyncStoreErrorCode>> => {
            // Transaction scoped, so a crash or a deadline releases it with the connection.
            const turn = await sql<{ held: boolean; state: string | null }>`
              select pg_try_advisory_xact_lock(${key}::bigint) as held,
                     (select state from app.git_bindings
                       where organization_id = ${tenant.organizationId}
                         and project_id = ${tenant.projectId} and id = ${bindingId}) as state`.execute(
              tx,
            );
            const row = turn.rows[0];
            if (row?.held !== true) return err('git_sync.busy');
            if (row.state === null) return err('git_sync.binding_not_found');
            if (row.state !== 'active') return err('git_sync.binding_inactive');
            // Only rows older than the claimed one are finished: a push that lands while this
            // runs is newer and stays queued for the next turn. One statement, as a claim is on
            // the path of every push.
            const picked = await sql<{
              id: string;
              delivery_id: string;
              head_sha: string | null;
              received_at: Date;
              superseded: number;
            }>`
              with newest as (
                select id, delivery_id, head_sha, received_at from app.git_deliveries
                 where organization_id = ${tenant.organizationId}
                   and project_id = ${tenant.projectId}
                   and binding_id = ${bindingId} and state = 'queued'
                 order by received_at desc, id desc
                 limit 1
                   for update skip locked),
              gone as (
                update app.git_deliveries d set state = 'done', finished_at = now()
                  from newest
                 where d.organization_id = ${tenant.organizationId}
                   and d.project_id = ${tenant.projectId}
                   and d.binding_id = ${bindingId} and d.state = 'queued'
                   and (d.received_at, d.id) < (newest.received_at, newest.id)
                returning 1)
              select newest.*, (select count(*) from gone)::integer as superseded
                from newest`.execute(tx);
            const newest = picked.rows[0];
            if (newest === undefined) return ok({ claimed: null, outcome: null, superseded: 0 });
            const claimed: ClaimedDelivery = {
              id: newest.id,
              bindingId,
              deliveryId: newest.delivery_id,
              headSha: newest.head_sha,
              receivedAt: newest.received_at,
            };
            const outcome = await work(claimed);
            await tx
              .updateTable('git_deliveries')
              .set({ state: outcome, finished_at: sql<Date>`now()` })
              .where('organization_id', '=', tenant.organizationId)
              .where('project_id', '=', tenant.projectId)
              .where('id', '=', newest.id)
              .execute();
            return ok({ claimed, outcome, superseded: newest.superseded });
          },
          { deadlineMs: options?.deadlineMs ?? DEFAULT_CLAIM_DEADLINE_MS },
        );
        const fields = { ...tenantFields(tenant), binding_id: bindingId };
        const duration_ms = Math.round(performance.now() - started);
        if (!result.ok) {
          logger.info('git_sync.claim_refused', { ...fields, code: result.error, duration_ms });
        } else if (result.value.claimed !== null) {
          logger.info('git_sync.delivery_claimed', {
            ...fields,
            delivery_id: result.value.claimed.deliveryId,
            outcome: result.value.outcome ?? 'none',
            superseded: result.value.superseded,
            duration_ms,
          });
        }
        return result;
      }),
  };
}
