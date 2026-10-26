// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { ColumnType, Generated } from '../../src/schema.generated.ts';
import type { Transaction } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OrganizationId, OrganizationRef, ProjectId, TenantRef } from '@drefyn/tenancy';
import {
  closeDatabase,
  withPublishedReader,
  withTenant,
  type Database,
  type PublishedDatabase,
  type PublishedSchema,
  type Schema,
} from '../../src/index.ts';
import type { PublishedTableName } from '../../src/allow-lists.ts';
import type { PublishedView } from '../../src/published.ts';

declare const db: Database;
declare const publishedDb: PublishedDatabase;
declare const org: OrganizationId;
declare const prj: ProjectId;
declare const orgRef: OrganizationRef;
declare const tenant: TenantRef;

// A schema with a draft and a published table, shaped like the generated types.
interface FixtureSchema {
  fixture_drafts: { id: Generated<string>; organization_id: string; body: string };
  fixture_published: {
    id: Generated<string>;
    organization_id: string;
    project_id: string;
    body: string;
    amount_cents: ColumnType<number, number | undefined, number>;
  };
}

type FixturePublished = PublishedView<FixtureSchema, 'fixture_published'>;
declare const publishedTx: Transaction<FixturePublished>;

async function compileOnly(): Promise<void> {
  // A ProjectId is not an OrganizationId.
  // @ts-expect-error a ProjectId passed as the organization
  await withTenant(db, { organizationId: prj }, () => Promise.resolve(1));
  // @ts-expect-error a ProjectId passed as the organization next to a real project
  await withTenant(db, { organizationId: prj, projectId: prj }, () => Promise.resolve(1));
  // @ts-expect-error an OrganizationId passed as the project
  await withTenant(db, { organizationId: org, projectId: org }, () => Promise.resolve(1));
  // @ts-expect-error a plain string is not an organization
  await withTenant(db, { organizationId: 'x' }, () => Promise.resolve(1));
  // @ts-expect-error a context is required
  await withTenant(db, {}, () => Promise.resolve(1));

  await withTenant(db, orgRef, () => Promise.resolve(1));
  await withTenant(db, tenant, () => Promise.resolve(1));
  await withTenant(db, { organizationId: org }, () => Promise.resolve(1), { timeoutMs: 100 });

  // The reader needs a project: a site belongs to one.
  // @ts-expect-error an OrganizationRef is not enough for the published reader
  await withPublishedReader(publishedDb, orgRef, () => Promise.resolve(1));
  await withPublishedReader(publishedDb, tenant, () => Promise.resolve(1));

  // Each pool only opens its own kind of transaction.
  // @ts-expect-error the app database is not a published database
  await withPublishedReader(db, tenant, () => Promise.resolve(1));
  // @ts-expect-error the published database cannot open a tenant transaction
  await withTenant(publishedDb, tenant, () => Promise.resolve(1));
  // @ts-expect-error a plain object is not a database
  await withTenant({}, tenant, () => Promise.resolve(1));

  await closeDatabase(db);
  await closeDatabase(publishedDb);

  // Only published tables are reachable from the reader's transaction.
  publishedTx.selectFrom('fixture_published').select(['id', 'body']);
  // @ts-expect-error a draft table is not on the published schema
  publishedTx.selectFrom('fixture_drafts').selectAll();
  const published = publishedTx.selectFrom('fixture_published');
  // @ts-expect-error a draft table cannot be joined either
  published.innerJoin('fixture_drafts', 'fixture_drafts.id', 'fixture_published.id');
}

describe('tenant access types', () => {
  it('compile as the comments say', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('give the work a transaction over the app schema', () => {
    expectTypeOf(withTenant<number>)
      .parameter(2)
      .parameter(0)
      .toEqualTypeOf<Transaction<Schema>>();
    expectTypeOf(withPublishedReader<number>)
      .parameter(2)
      .parameter(0)
      .toEqualTypeOf<Transaction<PublishedSchema>>();
  });

  it('build PublishedSchema from the published allow list only', () => {
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty until the first table is published
    expectTypeOf<PublishedSchema>().toEqualTypeOf<PublishedView<Schema, PublishedTableName>>();
    expectTypeOf<keyof FixturePublished>().toEqualTypeOf<'fixture_published'>();
  });

  it('keep the databases opaque', () => {
    expectTypeOf<keyof Database>().not.toEqualTypeOf<'pool'>();
    expectTypeOf<Database>().not.toHaveProperty('pool');
    expectTypeOf<Database>().not.toHaveProperty('query');
    expectTypeOf<PublishedDatabase>().not.toHaveProperty('pool');
  });
});
