import { randomUUID } from 'node:crypto';
import { withPublishedReader, type PublishedDatabase } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type { MovingActor, NodeId, VersionId } from '../../src/index.ts';
import { admin, type Seeded } from './fixture.ts';
import { nodeWithVersions } from './terms.ts';

export interface Page {
  readonly nodeId: NodeId;
  readonly versionIds: readonly VersionId[];
  readonly head: VersionId;
}

// A word no other page has, so a test can look for it anywhere a reader might find it.
export const canary = () =>
  `canary${randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => 'abcdefghij'.charAt(Number(digit)))}`;

// A page with two saved versions and their chunks, its head set to the last, written as the
// superuser so a run does not wait on the parse host.
export async function page(
  seeded: Seeded,
  options: { readonly parentId?: string; readonly slug?: string; readonly word?: string } = {},
): Promise<Page> {
  const word = options.word ?? canary();
  const made = await nodeWithVersions(
    seeded,
    [
      [{ headingPath: ['Intro'], body: `First words about ${word}.` }],
      [{ headingPath: ['Intro'], body: `Second words about ${word} and setup.` }],
    ],
    {
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      ...(options.slug === undefined ? {} : { slug: options.slug }),
    },
  );
  const versionIds = made.versionIds.map((id) => idOf('ver', id));
  const head = versionIds.at(-1);
  if (head === undefined) throw new Error('a page needs a version');
  await admin(`update app.nodes set head_version_id = '${head}' where id = '${made.nodeId}';`);
  return { nodeId: idOf('nod', made.nodeId), versionIds, head };
}

// Keys and pushes may publish, so a test can show the visibility rule is what stops them.
export const openWorkflow = (seeded: Seeded) =>
  admin(`
insert into app.publish_workflows (organization_id, project_id, api_keys_publish, git_publish)
  values ('${seeded.organization}', '${seeded.project}', true, true)
  on conflict (organization_id, project_id) do update set api_keys_publish = true, git_publish = true;`);

// Movers as well as publishers, so one set of actors drives every call.
const USER_ID = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099');
export const EDITOR: MovingActor = { kind: 'user', userId: USER_ID, roles: ['editor'] };
export const VIEWER: MovingActor = { kind: 'user', userId: USER_ID, roles: ['viewer'] };
export const KEY: MovingActor = {
  kind: 'api_key',
  keyId: '01890a5d-ac96-774b-bcce-b302099a8098',
  scopes: ['docs:pages.publish'],
};
export const GIT: MovingActor = {
  kind: 'git',
  installationId: '42',
  commitSha: 'a'.repeat(40),
  authorEmail: 'dev@example.com',
};
export const JOB: MovingActor = { kind: 'system', job: 'test' };

export interface PublicView {
  readonly versions: readonly string[];
  readonly filters: readonly string[];
  readonly chunks: readonly string[];
}

const nodes = (rows: readonly { node_id: string }[]) =>
  [...new Set(rows.map((row) => row.node_id))].sort();

// What the public reader role can see of a project, as node ids per table, through the same
// connection and tenant setting every public surface uses.
export function publicView(db: PublishedDatabase, seeded: Seeded): Promise<PublicView> {
  return withPublishedReader(db, seeded.tenant, async (tx) => ({
    versions: nodes(
      (await sql<{ node_id: string }>`select node_id::text from app.published_versions`.execute(tx))
        .rows,
    ),
    filters: nodes(
      (
        await sql<{
          node_id: string;
        }>`select node_id::text from app.published_filter_rows`.execute(tx)
      ).rows,
    ),
    chunks: nodes(
      (await sql<{ node_id: string }>`select node_id::text from app.published_chunks`.execute(tx))
        .rows,
    ),
  }));
}

// Every term table row is public by construction, so any posting at all for a node is a word
// of that node any reader can rank by.
export async function postedNodes(seeded: Seeded): Promise<readonly string[]> {
  const out = await admin(`
select distinct c.node_id from app.published_chunk_terms t
  join app.published_chunks c on c.id = t.chunk_id
 where t.organization_id = '${seeded.organization}' and t.project_id = '${seeded.project}'
 order by 1;`);
  return out.split('\n').filter((line) => line !== '');
}

// Rows per published table for one node, by visibility, as stored.
export async function storedVisibility(nodeId: string): Promise<string> {
  const out = await admin(`
select (select coalesce(string_agg(distinct visibility, ','), '-') from app.published_versions
         where node_id = '${nodeId}') || ' ' ||
       (select coalesce(string_agg(distinct visibility, ','), '-') from app.published_filter_rows
         where node_id = '${nodeId}') || ' ' ||
       (select coalesce(string_agg(distinct visibility, ','), '-') from app.published_chunks
         where node_id = '${nodeId}');`);
  return out.trim();
}
