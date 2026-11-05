// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import { describe, expectTypeOf, it } from 'vitest';
import {
  withOrganization,
  withTenant,
  type Database,
  type OrganizationSchema,
  type TenantSchema,
} from '../../src/index.ts';

declare const db: Database;
declare const tenant: TenantRef;
declare const org: OrganizationRef;

type EngineTable =
  | 'content_types'
  | 'nodes'
  | 'node_versions'
  | 'node_filter_rows'
  | 'chunks'
  | 'chunk_embeddings'
  | 'engine_outbox';

async function compileOnly(): Promise<void> {
  await withTenant(db, tenant, async (tx) => {
    await tx.selectFrom('nodes').select(['id', 'organization_id', 'project_id']).execute();
  });
  await withOrganization(db, org, async (tx) => {
    // @ts-expect-error organization work cannot name a project table
    await tx.selectFrom('nodes').selectAll().execute();
  });
}

// The tables in a schema that carry both tenant columns.
type ProjectTables<S> = {
  [K in keyof S]: 'organization_id' extends keyof S[K]
    ? 'project_id' extends keyof S[K]
      ? K
      : never
    : never;
}[keyof S];

describe('engine table types', () => {
  it('reach project work and never organization work', () => {
    expectTypeOf<Exclude<EngineTable, keyof TenantSchema>>().toBeNever();
    expectTypeOf<Extract<EngineTable, keyof OrganizationSchema>>().toBeNever();
    expectTypeOf(compileOnly).toBeFunction();
  });

  it('carry both tenant columns on every table', () => {
    expectTypeOf<Exclude<EngineTable, ProjectTables<TenantSchema>>>().toBeNever();
  });
});
