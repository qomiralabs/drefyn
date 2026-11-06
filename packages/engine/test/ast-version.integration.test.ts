import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDatabase,
  createDatabase,
  parseDatabaseConfig,
  withTenant,
  type Database,
} from '@drefyn/db';
import { AST_VERSION, rawOf, type MdxRoot } from '@drefyn/mdx';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { astVersionOf } from '../src/index.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser, urlFor } from './support/stack.ts';

// The trees the mdx freeze test proves the parser gives, so this file needs no parse host.
const pinFile = join(
  import.meta.dirname,
  '..',
  '..',
  'mdx',
  'test',
  'fixtures',
  'ast',
  `v${String(AST_VERSION)}.json`,
);
const pins = JSON.parse(readFileSync(pinFile, 'utf8')) as Readonly<Record<string, MdxRoot>>;

const organization = randomUUID();
const project = randomUUID();
const typeId = randomUUID();
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};

let db: Database;

async function storeVersion(root: MdxRoot): Promise<string> {
  const text = JSON.stringify(root);
  return withTenant(db, tenant, async (tx) => {
    const node = await tx
      .insertInto('nodes')
      .values({
        organization_id: organization,
        project_id: project,
        family: 'docs_page',
        type_id: typeId,
        order_key: 'a0',
        lifecycle: 'draft',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await tx
      .insertInto('node_versions')
      .values({
        organization_id: organization,
        project_id: project,
        node_id: node.id,
        seq: 1,
        schema_version: 1,
        ast_version: astVersionOf(root),
        origin: 'human',
        actor: '{}',
        content: text,
        content_sha256: createHash('sha256').update(text).digest(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return version.id;
  });
}

const readVersion = (id: string) =>
  withTenant(db, tenant, (tx) =>
    tx
      .selectFrom('node_versions')
      .select(['ast_version', 'content'])
      .where('organization_id', '=', organization)
      .where('project_id', '=', project)
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );

describeWithStack('astVersion on a stored version', () => {
  const name = inject('engineDatabase');

  beforeAll(async () => {
    await superuser(
      `insert into app.organizations (organization_id, name, plan_tier)
         values ('${organization}', 'Engine', 'self_hosted');
       insert into app.projects (id, organization_id, product, slug, name)
         values ('${project}', '${organization}', 'docs', 'engine', 'Engine');
       insert into app.content_types (id, organization_id, project_id, family, key)
         values ('${typeId}', '${organization}', '${project}', 'docs_page', 'page');`,
      name,
    );
    db = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', name),
        DREFYN_DATABASE_SSL: 'disable',
        DREFYN_DATABASE_POOL_MAX: '2',
        DREFYN_DATABASE_POOL_WAIT_MS: '10000',
      }),
    );
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  it.each(Object.entries(pins))('keeps the version of %s beside its tree', async (_name, root) => {
    const stored = await readVersion(await storeVersion(root));
    expect(stored.ast_version).toBe(AST_VERSION);
    expect(stored.content).toMatchObject({ astVersion: AST_VERSION });
  });

  // jsonb reorders keys, so this proves the hashes a block prints under survive being stored.
  it.each(Object.entries(pins))('gives %s back unchanged', async (_name, root) => {
    const stored = await readVersion(await storeVersion(root));
    expect(stored.content).toStrictEqual(root);
    const { children } = stored.content as unknown as MdxRoot;
    expect(children.map((block) => rawOf(block))).toEqual(
      root.children.map((block) => block.source?.rawOf),
    );
  });

  it('refuses a version with no ast_version', async () => {
    const node = randomUUID();
    await expect(
      superuser(
        `insert into app.nodes (id, organization_id, project_id, family, type_id, order_key,
           lifecycle)
         values ('${node}', '${organization}', '${project}', 'docs_page', '${typeId}', 'a0',
           'draft');
         insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
           origin, actor, content, content_sha256)
         values ('${organization}', '${project}', '${node}', 1, 1, 'human', '{}', '{}',
           decode(repeat('aa', 32), 'hex'));`,
        name,
      ),
    ).rejects.toThrow(/null value in column "ast_version"/);
  });
});
