import { randomUUID } from 'node:crypto';
import { appTermStore, createTermRebuild } from '@drefyn/retrieval';
import type { Database } from '@drefyn/db';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';

// What a docs page looks like to retrieval once publish has run: a node, its versions, the
// published copy and its chunks. Written as the superuser, then the term tables are rebuilt
// by the library, the same way publish keeps them.

// current: what a plain read gets. old: published once, since replaced. draft: never published.
export type PageState = 'current' | 'old' | 'draft';

export interface PageVersion {
  readonly state: PageState;
  readonly visibility?: 'public' | 'protected';
  readonly bodies: readonly string[];
}

export interface PageSpec {
  readonly slug: string;
  readonly versions: readonly PageVersion[];
}

export interface SeededChunks {
  // Published chunk ids by the state of the version they belong to.
  readonly current: readonly string[];
  readonly other: readonly string[];
}

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function seedDocs(
  sql: (text: string) => Promise<string>,
  app: Database,
  organizationId: OrganizationId,
  projectId: ProjectId,
  pages: readonly PageSpec[],
): Promise<SeededChunks> {
  const org = organizationId;
  const prj = projectId;
  const typeId = randomUUID();
  const rows: string[] = [
    `insert into app.content_types (id, organization_id, project_id, family, key)
       values ('${typeId}', '${org}', '${prj}', 'docs_page', 'page');`,
  ];
  const current: string[] = [];
  const other: string[] = [];
  for (const page of pages) {
    const nodeId = randomUUID();
    rows.push(
      `insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug,
          order_key, lifecycle)
        values ('${nodeId}', '${org}', '${prj}', 'docs_page', '${typeId}', null,
          ${text(page.slug)}, 'a${nodeId.replaceAll('-', '')}', 'draft');`,
    );
    page.versions.forEach((version, seq) => {
      const versionId = randomUUID();
      const visibility = version.visibility ?? 'public';
      const fields = text(JSON.stringify({ title: page.slug }));
      rows.push(
        `insert into app.node_versions (id, organization_id, project_id, node_id, seq,
            schema_version, ast_version, origin, actor, content, content_sha256, fields)
          values ('${versionId}', '${org}', '${prj}', '${nodeId}', ${String(seq + 1)}, 1, 1,
            'human', '{"kind":"system","job":"test"}', '{}', sha256('${versionId}'::bytea),
            ${fields});`,
      );
      version.bodies.forEach((body, ord) => {
        rows.push(
          `insert into app.chunks (organization_id, project_id, node_id, version_id, ord,
              block_path, heading_path, body, body_sha256)
            values ('${org}', '${prj}', '${nodeId}', '${versionId}', ${String(ord)},
              '${String(ord)}', array[${text(page.slug)}]::text[], ${text(body)},
              sha256(convert_to(${text(body)}, 'UTF8')));`,
        );
      });
      if (version.state === 'draft') return;
      const isCurrent = version.state === 'current';
      rows.push(
        `insert into app.published_versions (organization_id, project_id, node_id, version_id,
            type_id, content, fields, is_current, render_policy_version, visibility)
          values ('${org}', '${prj}', '${nodeId}', '${versionId}', '${typeId}', '{}', ${fields},
            ${String(isCurrent)}, 1, '${visibility}');`,
      );
      version.bodies.forEach((body, ord) => {
        const chunkId = randomUUID();
        (isCurrent && visibility === 'public' ? current : other).push(chunkId);
        rows.push(
          `insert into app.published_chunks (id, organization_id, project_id, node_id, version_id,
              ord, page_path, title, heading_path, body, body_sha256, visibility, is_current)
            values ('${chunkId}', '${org}', '${prj}', '${nodeId}', '${versionId}', ${String(ord)},
              ${text(`/${page.slug}`)}, ${text(page.slug)}, array[${text(page.slug)}]::text[],
              ${text(body)}, sha256(convert_to(${text(body)}, 'UTF8')), '${visibility}',
              ${String(isCurrent)});`,
        );
      });
    });
  }
  await sql(rows.join('\n'));
  const rebuilt = await createTermRebuild({ store: appTermStore(app) }).rebuildTermStats({
    organizationId,
    projectId,
  });
  if (!rebuilt.ok) throw new Error(`term rebuild failed: ${rebuilt.error}`);
  return { current, other };
}
