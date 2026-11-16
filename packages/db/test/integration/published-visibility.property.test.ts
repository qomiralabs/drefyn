import fc from 'fast-check';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import {
  withProtectedReader,
  withPublishedReader,
  type ProtectedReaderDatabase,
  type PublishedDatabase,
} from '../../src/index.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import {
  fixtureTemplate,
  pools,
  protectedUrl,
  rows,
  seed,
  seedProject,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const SEEDS = [7, 382, 20261116];
const RUNS_PER_SEED = 8;

type Visibility = 'public' | 'protected';

let appUrl: string;
let reader: PublishedDatabase;
let protectedReader: ProtectedReaderDatabase;

// Fresh ids for every execution, shrinking included, so no run sees rows an earlier one left.
let counter = 0;
function freshUuid(seed: number, tag: number): string {
  counter += 1;
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0').slice(-width);
  return `01a14984-4476-7${hex(seed % 4096, 3)}-8${hex(tag, 3)}-${hex(counter, 12)}`;
}

const visibility = fc.constantFrom<Visibility>('public', 'protected');
const row = fc.record({ body: fc.stringMatching(/^[a-z0-9 ]{0,12}$/), visibility });
// Two tenants in one organization and one in another, each with any mix of rows.
const shape = fc.array(fc.array(row, { maxLength: 6 }), { minLength: 3, maxLength: 3 });

interface Built {
  readonly ref: TenantRef;
  readonly rows: readonly { readonly body: string; readonly visibility: Visibility }[];
}

async function build(
  seedValue: number,
  tenants: readonly (readonly { body: string; visibility: Visibility }[])[],
): Promise<Built[]> {
  const shared = organizationId(freshUuid(seedValue, 1));
  const built: Built[] = [];
  for (const [at, list] of tenants.entries()) {
    const org = at === 2 ? organizationId(freshUuid(seedValue, 2)) : shared;
    const prj = projectId(freshUuid(seedValue, 3));
    await seedProject(appUrl, org, prj);
    await seed(
      appUrl,
      org,
      prj,
      list.map((r) => ({
        text: `insert into app.fixture_published (organization_id, project_id, body, visibility)
               values ($1, $2, $3, $4)`,
        values: [org, prj, r.body, r.visibility],
      })),
    );
    built.push({ ref: { organizationId: org, projectId: prj }, rows: list });
  }
  return built;
}

const everything = sql<{ body: string; visibility: string }>`
  select body, visibility from app.fixture_published`;

const key = (r: { body: string; visibility: string }) => `${r.visibility}|${r.body}`;
const sortedKeys = (list: readonly { body: string; visibility: string }[]) => list.map(key).sort();

describeWithStack('both readers against random published rows', () => {
  beforeAll(async () => {
    const db = await fixture();
    appUrl = db.app;
    reader = await open.reader(db.reader);
    protectedReader = await open.protectedReader(protectedUrl(db));
  });

  it.each(SEEDS)(
    'the public reader sees exactly its public rows, the protected one all of its own (seed %i)',
    async (seedValue) => {
      await fc.assert(
        fc.asyncProperty(shape, async (tenants) => {
          const built = await build(seedValue, tenants);
          for (const t of built) {
            const seenPublic = await withPublishedReader(reader, t.ref, (tx) =>
              rows(tx, everything),
            );
            expect(sortedKeys(seenPublic)).toEqual(
              sortedKeys(t.rows.filter((r) => r.visibility === 'public')),
            );
            const seenProtected = await withProtectedReader(
              protectedReader,
              { tenant: t.ref },
              (tx) => rows(tx, everything),
            );
            expect(sortedKeys(seenProtected)).toEqual(sortedKeys(t.rows));
          }
        }),
        { seed: seedValue, numRuns: RUNS_PER_SEED, endOnFailure: true },
      );
    },
  );
});
