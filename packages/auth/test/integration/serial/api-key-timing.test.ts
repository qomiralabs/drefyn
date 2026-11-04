import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import { formatApiKey, type ApiKeyVerifier } from '../../../src/index.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';

// verifyApiKey against the budgeted data: 2,000 organizations, 4,000 projects and 10,000 keys
// beside the keys measured, half of those limited to two projects. Steady state: every
// measured key was used in the warm up, so no use time is due, as within any hour of traffic.
// A shared runner's p99 swings with its neighbours (1.4 ms and 2.75 ms on two runs of the same
// commit), so CI holds p99 to a 10 ms ceiling that still catches a lost index or an extra round
// trip; the 3 ms p99 budget is measured on a quiet machine (TODO(#195)).

const fresh = harness();
let h: Harness;
let verifier: ApiKeyVerifier;
const measured: string[] = [];

const ORGS = 2_000;
const MEASURED_KEYS = 200;
const SAMPLES = 2_000;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describeWithStack('verifyApiKey timing', () => {
  beforeAll(async () => {
    h = await fresh();
    verifier = h.verifier({ limiter: { reserve: () => Promise.resolve() } });
    const creator = newId('usr');
    await h.sql(`
      insert into app.organizations (organization_id, name, plan_tier)
        select uuidv7(), 'Org ' || g, 'self_hosted' from generate_series(1, ${String(ORGS)}) g;
      insert into app.projects (organization_id, product, slug, name)
        select o.organization_id, 'docs', 'p' || n, 'Handbook'
          from app.organizations o cross join generate_series(1, 2) n;
      insert into app.users (id, email, email_normalized, email_verified_at)
        values ('${creator}', 'timing@example.com', 'timing@example.com', now());
      insert into app.memberships (organization_id, user_id, role)
        select organization_id, '${creator}', 'owner' from app.organizations;
      insert into app.api_keys (organization_id, name, secret_hash, display_suffix, scopes,
                                project_scope, created_by, idempotency_key, request_hash)
        select o.organization_id, 'Seed', sha256(random()::text::bytea), 'abcd',
               array['docs:read'], case when n % 2 = 0 then 'listed' else 'all' end,
               m.id, 'seed-' || n, sha256(n::text::bytea)
          from app.organizations o
          join app.memberships m using (organization_id)
          cross join generate_series(1, 5) n;
      insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
        select k.organization_id, k.id, p.id
          from app.api_keys k join app.projects p using (organization_id)
         where k.project_scope = 'listed';`);
    const orgs = (
      await h.sql(
        `select organization_id from app.organizations order by random() limit ${String(MEASURED_KEYS)};`,
      )
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const values: string[] = [];
    orgs.forEach((org, i) => {
      const keyId = newId('key');
      const secret = randomBytes(32);
      const scope = i % 2 === 0 ? 'listed' : 'all';
      values.push(
        `('${keyId}', '${org}', 'Measured', '\\x${hex(createHash('sha256').update(secret).digest())}', 'abcd', array['docs:read'], '${scope}', (select id from app.memberships where organization_id = '${org}'), 'measured-${String(i)}', '\\x${hex(Buffer.alloc(32))}')`,
      );
      measured.push(formatApiKey({ organizationId: idOf('org', org), keyId, secret }));
    });
    await h.sql(`
      insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
                                project_scope, created_by, idempotency_key, request_hash)
      values ${values.join(',\n')};
      insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
        select k.organization_id, k.id, p.id
          from app.api_keys k join app.projects p using (organization_id)
         where k.name = 'Measured' and k.project_scope = 'listed';
      analyze app.api_keys;
      analyze app.api_key_projects;`);
  });

  it('answers at p50 within 3 ms and p99 within the 10 ms CI ceiling', async () => {
    expect(measured).toHaveLength(MEASURED_KEYS);
    for (const key of measured) {
      const result = await verifier.verifyApiKey(`Bearer ${key}`, '203.0.113.60');
      if (!result.ok) throw result.error;
    }
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const key = measured[i % measured.length] ?? '';
      const started = performance.now();
      const result = await verifier.verifyApiKey(`Bearer ${key}`, '203.0.113.60');
      times.push(performance.now() - started);
      if (!result.ok) throw result.error;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const keys = await h.sql('select count(*) from app.api_keys;');
    // Printed for the PR.
    console.info(
      `verifyApiKey: ${String(SAMPLES)} samples over ${keys} keys in ${String(ORGS)} organizations, p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms (CI ceiling 10; the 3 ms p99 budget is measured on a quiet machine, #195)`,
    );
    expect(p50).toBeLessThanOrEqual(3);
    expect(p99).toBeLessThanOrEqual(10);
  });
});
