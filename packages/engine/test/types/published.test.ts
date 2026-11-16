// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  NodeId,
  PublishedReader,
  PublishedStore,
  PublishedTx,
  VersionId,
} from '../../src/index.ts';

declare const reader: PublishedReader;
declare const store: PublishedStore;
declare const tenant: TenantRef;
declare const org: OrganizationRef;
declare const node: NodeId;
declare const version: VersionId;
declare const tx: PublishedTx;

async function compileOnly(): Promise<void> {
  await reader.getPublished(tenant, node);
  await reader.getPublished(tenant, node, { versionId: version });
  await reader.listPublished(tenant, { typeId: 't' });
  // @ts-expect-error a published read needs the project, not just the organization
  await reader.getPublished(org, node);
  // @ts-expect-error a published list needs the project, not just the organization
  await reader.listPublished(org, { typeId: 't' });
  // @ts-expect-error a store read needs the project too
  await store.read(org, () => Promise.resolve(1));
  // @ts-expect-error a pin is a version id, never a node id
  await reader.getPublished(tenant, node, { versionId: node });
  // @ts-expect-error a node id is branded, a bare string is not one
  await reader.getPublished(tenant, 'nod');
  tx.selectFrom('published_versions').select('content');
  tx.selectFrom('published_filter_rows').select('t1');
  // @ts-expect-error the reader's transaction has no draft table
  tx.selectFrom('node_versions').select('content');
  // @ts-expect-error nor the draft filter rows
  tx.selectFrom('node_filter_rows').select('t1');
  // @ts-expect-error nor the nodes
  tx.selectFrom('nodes').select('head_content');
}

describe('the published reader types', () => {
  it('take a TenantRef with a project', () => {
    expectTypeOf<Parameters<PublishedReader['getPublished']>[0]>().toEqualTypeOf<TenantRef>();
    expectTypeOf<Parameters<PublishedReader['listPublished']>[0]>().toEqualTypeOf<TenantRef>();
    expectTypeOf(compileOnly).toBeFunction();
  });
});
