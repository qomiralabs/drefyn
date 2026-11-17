import { toSafeInteger, withTenant, type Database } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Installation, InstallationReader } from './broker.ts';
import { isGitHubId } from './types.ts';

export interface InstallationInput {
  readonly installationId: number;
  readonly accountId: number;
  readonly repositoryIds: readonly number[];
}

export interface InstallationStore extends InstallationReader {
  // Records which installation and repositories a project uses, replacing the repository list
  // of a row already there. Suspension is GitHub's to set, so recording never lifts it.
  record(tenant: TenantRef, input: InstallationInput): Promise<Installation>;
  setSuspended(tenant: TenantRef, installationId: number, suspended: boolean): Promise<boolean>;
  remove(tenant: TenantRef, installationId: number): Promise<boolean>;
}

const MAX_REPOSITORIES = 100;
const githubId = z.number().refine(isGitHubId);
const inputShape = z.strictObject({
  installationId: githubId,
  accountId: githubId,
  repositoryIds: z
    .array(githubId)
    .min(1)
    .max(MAX_REPOSITORIES)
    .refine((ids) => new Set(ids).size === ids.length),
});

function checked(input: InstallationInput): InstallationInput {
  const parsed = inputShape.safeParse(input);
  if (!parsed.success) throw new TypeError('github: invalid installation input');
  return parsed.data;
}

function checkedId(installationId: number): number {
  if (!isGitHubId(installationId)) throw new TypeError('github: invalid installation id');
  return installationId;
}

interface Row {
  installation_id: number;
  account_id: number;
  repository_ids: number[];
  suspended_at: Date | null;
}

const toInstallation = (tenant: TenantRef, row: Row): Installation => ({
  tenant,
  installationId: toSafeInteger(row.installation_id, 'installation_id'),
  accountId: toSafeInteger(row.account_id, 'account_id'),
  repositoryIds: row.repository_ids.map((id) => toSafeInteger(id, 'repository_ids')),
  suspended: row.suspended_at !== null,
});

const COLUMNS = ['installation_id', 'account_id', 'repository_ids', 'suspended_at'] as const;

// Every read and write runs under the project's tenant context, so row level security keeps
// one project's installations out of every other project's reach.
export function createInstallationStore(deps: { readonly db: Database }): InstallationStore {
  const { db } = deps;
  return Object.freeze({
    async record(tenant: TenantRef, input: InstallationInput): Promise<Installation> {
      const { installationId, accountId, repositoryIds } = checked(input);
      const sorted = [...repositoryIds].sort((a, b) => a - b);
      const row = await withTenant(db, tenant, (tx) =>
        tx
          .insertInto('github_installations')
          .values({
            organization_id: tenant.organizationId,
            project_id: tenant.projectId,
            installation_id: installationId,
            account_id: accountId,
            repository_ids: sorted,
          })
          .onConflict((oc) =>
            oc.columns(['organization_id', 'project_id', 'installation_id']).doUpdateSet({
              account_id: accountId,
              repository_ids: sorted,
              updated_at: sql<Date>`now()`,
            }),
          )
          .returning(COLUMNS)
          .executeTakeFirstOrThrow(),
      );
      return toInstallation(tenant, row);
    },

    async get(tenant: TenantRef, installationId: number): Promise<Installation | null> {
      const id = checkedId(installationId);
      const row = await withTenant(db, tenant, (tx) =>
        tx
          .selectFrom('github_installations')
          .select(COLUMNS)
          .where('organization_id', '=', tenant.organizationId)
          .where('project_id', '=', tenant.projectId)
          .where('installation_id', '=', id)
          .executeTakeFirst(),
      );
      return row === undefined ? null : toInstallation(tenant, row);
    },

    async setSuspended(
      tenant: TenantRef,
      installationId: number,
      suspended: boolean,
    ): Promise<boolean> {
      const id = checkedId(installationId);
      const result = await withTenant(db, tenant, (tx) =>
        tx
          .updateTable('github_installations')
          .set({
            suspended_at: suspended ? sql<Date>`now()` : null,
            updated_at: sql<Date>`now()`,
          })
          .where('organization_id', '=', tenant.organizationId)
          .where('project_id', '=', tenant.projectId)
          .where('installation_id', '=', id)
          .executeTakeFirst(),
      );
      return result.numUpdatedRows > 0n;
    },

    async remove(tenant: TenantRef, installationId: number): Promise<boolean> {
      const id = checkedId(installationId);
      const result = await withTenant(db, tenant, (tx) =>
        tx
          .deleteFrom('github_installations')
          .where('organization_id', '=', tenant.organizationId)
          .where('project_id', '=', tenant.projectId)
          .where('installation_id', '=', id)
          .executeTakeFirst(),
      );
      return result.numDeletedRows > 0n;
    },
  });
}
