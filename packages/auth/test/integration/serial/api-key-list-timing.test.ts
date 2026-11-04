import { withOrganization } from '@drefyn/db';
import { CompiledQuery } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import type { ApiKeys, ListApiKeysInput } from '../../../src/index.ts';
import { memberOf, newOrg, recordingStore, type Org } from '../support/api-keys.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';

// listApiKeys for one organization of 1,000 keys, beside 100,000 keys of other organizations.
// Half the keys are limited to two projects, and a tenth are revoked. The table has to be this
// big: at 11,000 rows Postgres still walks the primary key backward and filters, which is the
// cheaper plan by its estimate, and it moves to the unique (organization_id, id) well before
// 100,000.

const fresh = harness();
let h: Harness;
let org: Org;
let keys: ApiKeys;

const KEYS = 1_000;
const OTHER_ORGS = 20_000;
const SAMPLES = 1_000;

const QUERIES: readonly ListApiKeysInput[] = [
  {},
  { search: 'deploy' },
  { products: ['docs'] },
  { lastUsed: 'never' },
  { search: 'zzz', products: ['status'], lastUsed: '7d' },
];

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describeWithStack('listApiKeys timing', () => {
  beforeAll(async () => {
    h = await fresh();
    keys = h.apiKeys();
    org = await newOrg(h);
    await memberOf(h, org, 'admin');
    await h.sql(`
      insert into app.projects (organization_id, product, slug, name)
        select '${org.organizationId}', 'docs', 'p' || n, 'Handbook' from generate_series(1, 2) n;
      insert into app.api_keys (organization_id, name, secret_hash, display_suffix, scopes,
                                project_scope, created_by, idempotency_key, request_hash,
                                revoked_at, last_used_at)
        select '${org.organizationId}', 'Deploy ' || n, sha256(n::text::bytea), 'abcd',
               case when n % 3 = 0 then array['docs:read', 'status:read'] else array['docs:read'] end,
               case when n % 2 = 0 then 'listed' else 'all' end,
               (select id from app.memberships
                 where organization_id = '${org.organizationId}'
                 order by id offset n % 2 limit 1),
               'seed-' || n, sha256(n::text::bytea),
               case when n % 10 = 0 then now() end,
               case when n % 4 = 0 then now() - interval '2 days' end
          from generate_series(1, ${String(KEYS)}) n;
      insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
        select k.organization_id, k.id, p.id
          from app.api_keys k join app.projects p using (organization_id)
         where k.project_scope = 'listed';
      insert into app.organizations (organization_id, name, plan_tier)
        select uuidv7(), 'Other ' || g, 'self_hosted' from generate_series(1, ${String(OTHER_ORGS)}) g;
      insert into app.memberships (organization_id, user_id, role)
        select organization_id, '${org.owner.userId}', 'owner' from app.organizations
         where organization_id <> '${org.organizationId}';
      insert into app.api_keys (organization_id, name, secret_hash, display_suffix, scopes,
                                project_scope, created_by, idempotency_key, request_hash)
        select m.organization_id, 'Seed', sha256(n::text::bytea), 'abcd', array['docs:read'],
               'all', m.id, 'seed-' || n, sha256(n::text::bytea)
          from app.memberships m cross join generate_series(1, 5) n
         where m.organization_id <> '${org.organizationId}';
      analyze app.api_keys;
      analyze app.api_key_projects;
      analyze app.memberships;`);
  }, 120_000);

  it('answers within 30 ms at p99 for 1,000 keys', async () => {
    const first = await keys.listApiKeys(org.owner, {});
    if (!first.ok) throw first.error;
    expect(first.value.total).toBe(KEYS);
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const query = QUERIES[i % QUERIES.length] ?? {};
      const started = performance.now();
      const result = await keys.listApiKeys(org.owner, query);
      times.push(performance.now() - started);
      if (!result.ok) throw result.error;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    // Printed for the PR.
    console.info(
      `listApiKeys: ${String(SAMPLES)} samples over ${String(KEYS)} keys, p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms (budget 30)`,
    );
    expect(p99).toBeLessThanOrEqual(30);
  });

  it('walks the page by an index scan on the unique organization and id', async () => {
    const recorded = recordingStore(h);
    const result = await h.apiKeys({ store: recorded.store }).listApiKeys(org.owner, {});
    if (!result.ok) throw result.error;
    const [page] = recorded.statements;
    if (page === undefined) throw new Error('nothing was sent');
    expect(page.sql).toContain('limit');
    const plan = await withOrganization(h.db, { organizationId: org.organizationId }, (tx) =>
      tx.executeQuery<{ 'QUERY PLAN': string }>(
        CompiledQuery.raw(`explain ${page.sql}`, [...page.parameters]),
      ),
    );
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(text, text).toMatch(/Index Scan( Backward)? using api_keys_organization_id_id_key/);
  });
});
