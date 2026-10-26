import fc from 'fast-check';
import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { withTenant, type Database } from '../../src/index.ts';
import type { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { fixtureTemplate, pools, rows, seed, seedProject } from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const SEEDS = [1, 42, 20261026];
const RUNS_PER_SEED = 8;

let appUrl: string;
let app: Database;

// Fresh ids for every execution, shrinking included, so no run collides with rows an
// earlier one left. Deterministic for a seed.
let counter = 0;
function freshUuid(seed: number, tag: number): string {
  counter += 1;
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0').slice(-width);
  return `01a14984-4476-7${hex(seed % 4096, 3)}-8${hex(tag, 3)}-${hex(counter, 12)}`;
}

interface OrgData {
  readonly ref: OrganizationRef;
  readonly projects: readonly { readonly ref: TenantRef; readonly bodies: readonly string[] }[];
}

// Postgres text cannot hold NUL.
const body = fc.string({ maxLength: 12 }).filter((s) => !s.includes('\u0000'));

const shape = fc.record({
  a: fc.array(fc.array(body, { maxLength: 4 }), { minLength: 1, maxLength: 3 }),
  b: fc.array(fc.array(body, { maxLength: 4 }), { minLength: 1, maxLength: 3 }),
  guesses: fc.array(fc.uuid({ version: 7 }), { maxLength: 4 }),
});

async function build(
  seedValue: number,
  tag: number,
  projects: readonly (readonly string[])[],
): Promise<OrgData> {
  const org = organizationId(freshUuid(seedValue, tag));
  const built: { ref: TenantRef; bodies: readonly string[] }[] = [];
  for (const bodies of projects) {
    const prj = projectId(freshUuid(seedValue, tag));
    await seedProject(appUrl, org, prj);
    await seed(
      appUrl,
      org,
      prj,
      bodies.map((body) => ({
        text: 'insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, $3)',
        values: [org, prj, body],
      })),
    );
    built.push({ ref: { organizationId: org, projectId: prj }, bodies });
  }
  return { ref: { organizationId: org }, projects: built };
}

const notes = sql<{ id: string; project_id: string; body: string }>`
  select id::text, project_id::text, body from app.fixture_notes`;

const sorted = (values: readonly string[]) => [...values].sort();

async function bodiesOf(ref: OrganizationRef | TenantRef): Promise<string[]> {
  return sorted((await withTenant(app, ref, (tx) => rows(tx, notes))).map((n) => n.body));
}

async function idsOf(ref: OrganizationRef): Promise<string[]> {
  return (await withTenant(app, ref, (tx) => rows(tx, notes))).map((n) => n.id);
}

describeWithStack('cross tenant isolation over random datasets', () => {
  beforeAll(async () => {
    const db = await fixture();
    appUrl = db.app;
    app = await open.app(db.app, { DREFYN_DATABASE_POOL_MAX: '4' });
  });

  it.each(SEEDS)(
    'organization A never reads, changes or deletes B rows, seed %i',
    async (seedValue) => {
      await fc.assert(
        fc.asyncProperty(shape, async ({ a: aShape, b: bShape, guesses }) => {
          const [a, b] = await Promise.all([
            build(seedValue, 0xa, aShape),
            build(seedValue, 0xb, bShape),
          ]);
          const aBodies = sorted(a.projects.flatMap((p) => p.bodies));
          const bBodies = sorted(b.projects.flatMap((p) => p.bodies));
          const bIds = await idsOf(b.ref);
          const aIds = await idsOf(a.ref);
          expect(bIds).toHaveLength(bBodies.length);

          // Reads: each organization and each project sees exactly its own, run concurrently.
          const reads = await Promise.all([
            bodiesOf(a.ref),
            bodiesOf(b.ref),
            ...a.projects.map((p) => bodiesOf(p.ref)),
            ...b.projects.map((p) => bodiesOf(p.ref)),
          ]);
          expect(reads[0]).toEqual(aBodies);
          expect(reads[1]).toEqual(bBodies);
          [...a.projects, ...b.projects].forEach((p, i) => {
            expect(reads[i + 2]).toEqual(sorted(p.bodies));
          });

          // A's organization with one of B's projects sees nothing at all.
          const crossed = {
            organizationId: a.ref.organizationId,
            projectId: b.projects[0]?.ref.projectId ?? projectId(freshUuid(seedValue, 0xc)),
          };
          expect(await bodiesOf(crossed)).toEqual([]);

          // Guessed and real foreign ids: no reads, no updates, no deletes.
          const targets = [...bIds, ...guesses];
          const touched = await withTenant(app, a.ref, async (tx) => {
            let n = 0n;
            for (const id of targets) {
              const read =
                await sql`select 1 from app.fixture_notes where id = ${id}::uuid`.execute(tx);
              const update =
                await sql`update app.fixture_notes set body = 'taken' where id = ${id}::uuid`.execute(
                  tx,
                );
              const remove =
                await sql`delete from app.fixture_notes where id = ${id}::uuid`.execute(tx);
              n +=
                BigInt(read.rows.length) +
                (update.numAffectedRows ?? 0n) +
                (remove.numAffectedRows ?? 0n);
            }
            const bulk =
              await sql`delete from app.fixture_notes where id = any(${targets}::uuid[])`.execute(
                tx,
              );
            return n + (bulk.numAffectedRows ?? 0n);
          });
          expect(touched).toBe(0n);

          // A blanket update in A touches exactly A's rows.
          const updated = await withTenant(
            app,
            a.ref,
            async (tx) =>
              (await sql`update app.fixture_notes set body = body`.execute(tx)).numAffectedRows,
          );
          expect(updated).toBe(BigInt(aIds.length));

          // Writing into B, or moving an A row to B, is refused.
          const target = b.projects[0]?.ref;
          if (target !== undefined) {
            const insert = await rejected(
              withTenant(app, a.ref, (tx) =>
                sql`insert into app.fixture_notes (organization_id, project_id, body) values (${target.organizationId}, ${target.projectId}, 'planted')`.execute(
                  tx,
                ),
              ),
            );
            expect((insert as DbError).code).toBe('DB_RLS_VIOLATION');
            const moved = aIds[0];
            if (moved !== undefined) {
              const move = await rejected(
                withTenant(app, a.ref, (tx) =>
                  sql`update app.fixture_notes set organization_id = ${target.organizationId}, project_id = ${target.projectId} where id = ${moved}::uuid`.execute(
                    tx,
                  ),
                ),
              );
              expect((move as DbError).code).toBe('DB_RLS_VIOLATION');
            }
          }

          // B is exactly as it was.
          expect(await bodiesOf(b.ref)).toEqual(bBodies);
          expect(sorted(await idsOf(b.ref))).toEqual(sorted(bIds));
        }),
        { seed: seedValue, numRuns: RUNS_PER_SEED },
      );
    },
  );
});
