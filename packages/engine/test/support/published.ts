import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import { admin, database, type Seeded } from './fixture.ts';
import { urlFor } from './stack.ts';

// Writes published rows as the superuser until the publish transaction exists. Test only: the
// one writer of these tables in the product is publish.

export const openReader = (): Promise<PublishedDatabase> =>
  createPublishedDatabase(
    parsePublishedReaderConfig({
      DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', database()),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );

export const openApp = (): Promise<Database> =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', database()),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );

const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

export interface DraftNode {
  readonly nodeId: string;
  readonly versionIds: readonly string[];
}

export interface NodeShape {
  readonly versions: number;
  readonly lifecycle?: 'draft' | 'published' | 'archived';
  readonly deleted?: boolean;
}

// A node with saved versions, each holding draft content that names itself, so a test can tell
// any draft that leaks.
export async function draftNodes(
  seeded: Seeded,
  shapes: readonly NodeShape[],
): Promise<readonly DraftNode[]> {
  const nodes = shapes.map((shape) => ({
    shape,
    nodeId: randomUUID(),
    versionIds: Array.from({ length: shape.versions }, () => randomUUID()),
  }));
  if (nodes.length === 0) return [];
  const { organization: org, project: prj, typeId } = seeded;
  const nodeRows = nodes.map(
    ({ nodeId, shape }, at) =>
      `('${nodeId}', '${org}', '${prj}', 'docs_page', '${typeId}', 'a${String(at)}',
        '${shape.lifecycle ?? 'draft'}', ${shape.deleted === true ? 'now()' : 'null'})`,
  );
  const versionRows = nodes.flatMap(({ nodeId, versionIds }) =>
    versionIds.map(
      (versionId, at) =>
        `('${versionId}', '${org}', '${prj}', '${nodeId}', ${String(at + 1)}, 1, 1, 'human',
          '{"kind":"system","job":"test"}', ${json({ draft: versionId })},
          sha256('${versionId}'::bytea))`,
    ),
  );
  await admin(`
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle,
    deleted_at)
  values ${nodeRows.join(',\n')};
${
  versionRows.length === 0
    ? ''
    : `insert into app.node_versions (id, organization_id, project_id, node_id, seq,
    schema_version, ast_version, origin, actor, content, content_sha256)
  values ${versionRows.join(',\n')};`
}`);
  return nodes.map(({ nodeId, versionIds }) => ({ nodeId, versionIds }));
}

export interface PublishedRow {
  readonly nodeId: string;
  readonly versionId: string;
  readonly current: boolean;
  readonly fields?: Readonly<Record<string, unknown>>;
  // Slot column to value, written to the filter row when the version is current.
  readonly slots?: Readonly<Record<string, string | number>>;
}

export const publishedContent = (versionId: string) => ({ published: versionId });

export async function publish(seeded: Seeded, rows: readonly PublishedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { organization: org, project: prj, typeId } = seeded;
  const versions = rows.map(
    (row) =>
      `('${org}', '${prj}', '${row.nodeId}', '${row.versionId}', '${typeId}',
        ${json(publishedContent(row.versionId))}, ${json(row.fields ?? {})}, ${String(row.current)}, 1)`,
  );
  const filters = rows
    .filter((row) => row.current)
    .map((row) => {
      const slots = Object.entries(row.slots ?? {});
      const columns = slots.map(([column]) => `, ${column}`).join('');
      const values = slots
        .map(([, value]) => `, ${typeof value === 'number' ? String(value) : `'${value}'`}`)
        .join('');
      return `insert into app.published_filter_rows
  (organization_id, project_id, type_id, node_id${columns})
  values ('${org}', '${prj}', '${typeId}', '${row.nodeId}'${values});`;
    });
  await admin(`
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, fields, is_current, render_policy_version)
  values ${versions.join(',\n')};
${filters.join('\n')}`);
}
