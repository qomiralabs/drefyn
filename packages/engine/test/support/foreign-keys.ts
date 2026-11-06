export interface ForeignKeyCost {
  readonly checks: number;
  readonly ms: number;
}

export interface ChunkTarget {
  readonly organization: string;
  readonly project: string;
  readonly node: string;
  readonly version: string;
}

interface Trigger {
  readonly 'Trigger Name': string;
  readonly Time: number;
}

// Time spent in foreign key triggers for one chunk insert, rolled back after. A check moves to a
// generic plan after a few rows, and without tenant statistics that plan walks a tenant's rows
// for each chunk, so this has to run with a full insert and not a single row.
export async function chunkForeignKeyCost(
  run: (text: string) => Promise<string>,
  target: ChunkTarget,
  chunks: number,
): Promise<ForeignKeyCost> {
  const { organization, project, node, version } = target;
  const plan = await run(`
begin;
explain (analyze, format json)
insert into app.chunks (organization_id, project_id, node_id, version_id, ord, block_path,
    heading_path, body, body_sha256)
  select '${organization}', '${project}', '${node}', '${version}', 100000 + ord, '0', '{}',
         'body', sha256(ord::text::bytea)
  from generate_series(0, ${String(chunks - 1)}) ord;
rollback;`);
  const [{ Triggers }] = JSON.parse(plan.slice(plan.indexOf('['), plan.lastIndexOf(']') + 1)) as [
    { Triggers: readonly Trigger[] },
  ];
  const checks = Triggers.filter((trigger) => trigger['Trigger Name'].startsWith('RI_'));
  return { checks: checks.length, ms: checks.reduce((total, { Time }) => total + Time, 0) };
}
