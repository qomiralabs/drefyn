import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { superuser } from '../test/support/stack.ts';

// Loading for the bench and the recall eval. Written as the superuser over the container
// socket, as the tests seed, then the term tables are built by the library's own rebuild.

export interface CorpusChunk {
  // The source set's id for the chunk, so a question can name its gold chunk.
  readonly ref: string;
  readonly heading: readonly string[];
  readonly body: string;
}

export interface CorpusPage {
  readonly path: string;
  readonly title: string;
  readonly chunks: readonly CorpusChunk[];
}

export interface Question {
  readonly kind: 'answerable' | 'unanswerable';
  readonly text: string;
  readonly gold: string | null;
}

export interface QuestionSet {
  readonly pages: readonly CorpusPage[];
  readonly questions: readonly Question[];
}

export interface Project {
  readonly tenant: TenantRef;
  readonly typeId: string;
}

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
const textArray = (values: readonly string[]) =>
  values.length === 0 ? `'{}'::text[]` : `array[${values.map(text).join(', ')}]::text[]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const field = (row: Record<string, unknown>, name: string): string => {
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`the set has a row without a text ${name}`);
  return value;
};

// The #637 output directory: chunks.json and the three question files. Held out chunks are left
// out of the corpus, as #637 and #619 measured, so held out questions have no gold chunk.
export function readSet(dir: string): QuestionSet {
  const read = (name: string): Record<string, unknown>[] => {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error(`${name} is not a list`);
    return parsed;
  };
  const pages = new Map<string, { title: string; chunks: (CorpusChunk & { ord: number })[] }>();
  for (const row of read('chunks.json')) {
    if (row['heldOut'] === true) continue;
    const page = field(row, 'page');
    const heading = Array.isArray(row['heading'])
      ? row['heading'].filter((h): h is string => typeof h === 'string')
      : [];
    const entry = pages.get(page) ?? { title: field(row, 'title'), chunks: [] };
    entry.chunks.push({
      ref: field(row, 'id'),
      heading,
      body: field(row, 'body'),
      ord: typeof row['ord'] === 'number' ? row['ord'] : entry.chunks.length,
    });
    pages.set(page, entry);
  }
  const questions: Question[] = [
    ...read('q-answerable.json').map((q) => ({
      kind: 'answerable' as const,
      text: field(q, 'question'),
      gold: field(q, 'chunkId'),
    })),
    ...[...read('q-heldout.json'), ...read('q-offsite.json')].map((q) => ({
      kind: 'unanswerable' as const,
      text: field(q, 'question'),
      gold: null,
    })),
  ];
  return {
    pages: [...pages].map(([path, page]) => ({
      path: `/${path}`,
      title: page.title,
      chunks: page.chunks.sort((a, b) => a.ord - b.ord),
    })),
    questions,
  };
}

// A deterministic corpus with a Zipf shaped vocabulary, for timing when no question set is
// given. Questions mix a chunk's own words with common ones, the way a person asks.
export function syntheticSet(seed = 572): QuestionSet {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vocabulary = Array.from({ length: 6000 }, (_, n) => `w${n.toString(36)}`);
  const weights = vocabulary.map((_, n) => 1 / (n + 1) ** 1.07);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const cumulative: number[] = [];
  weights.reduce((sum, w) => {
    cumulative.push((sum + w) / total);
    return sum + w;
  }, 0);
  const word = () => {
    const r = random();
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((cumulative[mid] ?? 1) < r) low = mid + 1;
      else high = mid;
    }
    return vocabulary[low] ?? 'w0';
  };
  const pages: CorpusPage[] = [];
  let made = 0;
  for (let p = 0; made < 1121; p += 1) {
    const count = Math.min(1121 - made, 5 + Math.floor(random() * 16));
    pages.push({
      path: `/synthetic/page-${String(p)}`,
      title: `Page ${String(p)}`,
      chunks: Array.from({ length: count }, (_, c) => ({
        ref: `${String(p)}#${String(c)}`,
        heading: [`Page ${String(p)}`, word()],
        body: Array.from({ length: 30 + Math.floor(random() * 90) }, word).join(' '),
      })),
    });
    made += count;
  }
  const all = pages.flatMap((page) => page.chunks);
  const questions: Question[] = Array.from({ length: 300 }, () => {
    const gold = all[Math.floor(random() * all.length)];
    const own = (gold?.body ?? '').split(' ');
    const picked = Array.from({ length: 4 + Math.floor(random() * 8) }, () => {
      return own[Math.floor(random() * own.length)] ?? 'w0';
    });
    const common = Array.from({ length: 3 + Math.floor(random() * 4) }, () => {
      return vocabulary[Math.floor(random() * 30)] ?? 'w0';
    });
    return { kind: 'answerable', text: [...common, ...picked].join(' '), gold: gold?.ref ?? null };
  });
  return { pages, questions };
}

export async function createProjects(database: string, count: number): Promise<Project[]> {
  const org = randomUUID();
  const projects = Array.from({ length: count }, () => ({
    tenant: { organizationId: organizationId(org), projectId: projectId(randomUUID()) },
    typeId: randomUUID(),
  }));
  await superuser(
    [
      `insert into app.organizations (organization_id, name, plan_tier) values ('${org}', 'Bench', 'self_hosted');`,
      ...projects.map(
        ({ tenant, typeId }) => `
insert into app.projects (id, organization_id, product, slug, name)
  values ('${tenant.projectId}', '${org}', 'docs', 'p${tenant.projectId.slice(0, 8)}', 'Bench');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${org}', '${tenant.projectId}', 'docs_page', 'page');`,
      ),
    ].join('\n'),
    database,
  );
  return projects;
}

// Every page as one node with one current, public, published version. Returns the chunk ids
// by the set's ref.
export async function loadPages(
  database: string,
  project: Project,
  pages: readonly CorpusPage[],
): Promise<Map<string, string>> {
  const org = project.tenant.organizationId;
  const prj = project.tenant.projectId;
  const ids = new Map<string, string>();
  const statements: string[] = [];
  for (const page of pages) {
    const nodeId = randomUUID();
    const versionId = randomUUID();
    const fields = text(JSON.stringify({ title: page.title }));
    statements.push(`
insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug, order_key,
    lifecycle)
  values ('${nodeId}', '${org}', '${prj}', 'docs_page', '${project.typeId}', null,
    ${text(nodeId)}, 'a${nodeId.replaceAll('-', '')}', 'draft');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, fields)
  values ('${versionId}', '${org}', '${prj}', '${nodeId}', 1, 1, 1, 'human',
    '{"kind":"system","job":"bench"}', '{}', sha256('${versionId}'::bytea), ${fields});
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, fields, is_current, render_policy_version, visibility)
  values ('${org}', '${prj}', '${nodeId}', '${versionId}', '${project.typeId}', '{}', ${fields},
    true, 1, 'public');`);
    page.chunks.forEach((chunk, ord) => {
      const id = randomUUID();
      ids.set(chunk.ref, id);
      statements.push(`
insert into app.published_chunks (id, organization_id, project_id, node_id, version_id, ord,
    page_path, title, heading_path, body, body_sha256, visibility, is_current)
  values ('${id}', '${org}', '${prj}', '${nodeId}', '${versionId}', ${String(ord)},
    ${text(page.path)}, ${text(page.title)}, ${textArray(chunk.heading)}, ${text(chunk.body)},
    sha256(convert_to(${text(chunk.body)}, 'UTF8')), 'public', true);`);
    });
  }
  // A few thousand rows per call keeps each psql input small.
  for (let at = 0; at < statements.length; at += 2000) {
    await superuser(statements.slice(at, at + 2000).join('\n'), database);
  }
  return ids;
}

// Copy k of the source project into the target, as the spike grew its projects: new ids, the
// same text (or each body's words reversed, for other tenants), paths suffixed with the copy.
// limit cuts the copy short by chunks, for sizes that are not a whole number of copies.
export async function copyProject(
  database: string,
  source: Project,
  target: Project,
  k: number,
  options: { readonly limit?: number; readonly reverse?: boolean } = {},
): Promise<void> {
  const s = source.tenant;
  const t = target.tenant;
  const tag = `${t.projectId}:${String(k)}:`;
  const node = (column: string) => `md5('${tag}' || ${column}::text)::uuid`;
  const version = (column: string) => `md5('${tag}v' || ${column}::text)::uuid`;
  const body =
    options.reverse === true
      ? `array_to_string(array(select w from unnest(string_to_array(c.body, ' '))
           with ordinality as x(w, i) order by i desc), ' ')`
      : 'c.body';
  const from = (alias: string) =>
    `${alias}.organization_id = '${s.organizationId}' and ${alias}.project_id = '${s.projectId}'`;
  await superuser(
    `
insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug, order_key,
    lifecycle)
select ${node('n.id')}, '${t.organizationId}', '${t.projectId}', n.family, '${target.typeId}', null,
       md5('${tag}' || n.id::text), 'a' || md5('${tag}' || n.id::text), n.lifecycle
  from app.nodes n where ${from('n')};
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, fields)
select ${version('v.id')}, '${t.organizationId}', '${t.projectId}', ${node('v.node_id')}, v.seq,
       v.schema_version, v.ast_version, v.origin, v.actor, v.content,
       sha256(convert_to('${tag}' || v.id::text, 'UTF8')), v.fields
  from app.node_versions v where ${from('v')};
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, fields, is_current, render_policy_version, visibility)
select '${t.organizationId}', '${t.projectId}', ${node('p.node_id')}, ${version('p.version_id')},
       '${target.typeId}', p.content, p.fields, p.is_current, p.render_policy_version, p.visibility
  from app.published_versions p where ${from('p')};
insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
    page_path, title, heading_path, body, body_sha256, visibility, is_current)
select '${t.organizationId}', '${t.projectId}', ${node('c.node_id')}, ${version('c.version_id')},
       c.ord, c.page_path || '@${String(k)}', c.title, c.heading_path, ${body},
       sha256(convert_to(${body}, 'UTF8')), c.visibility, c.is_current
  from (select * from app.published_chunks c where ${from('c')} order by c.id
        ${options.limit === undefined ? '' : `limit ${String(options.limit)}`}) c;`,
    database,
  );
}
