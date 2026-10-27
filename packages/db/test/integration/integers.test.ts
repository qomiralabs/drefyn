import { organizationId, projectId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { withTenant, type Database } from '../../src/index.ts';
import { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { fixtureTemplate, one, pools, rows, seed, seedProject } from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const ORG = organizationId('01a14984-4476-77ce-9335-40000000000a');
const PRJ = projectId('01a14984-4476-77ce-9335-4000000000a1');
// Project scope: organization scope reads no project rows.
const A = { organizationId: ORG, projectId: PRJ };

let app: Database;

describeWithStack('bigint values read through withTenant', () => {
  beforeAll(async () => {
    const db = await fixture();
    await seedProject(db.app, ORG, PRJ);
    // Written past the app on purpose: the database accepts it, the read must not.
    await seed(db.app, ORG, PRJ, [
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body, amount_cents) values ($1, $2, 'max', 9007199254740991)",
        values: [ORG, PRJ],
      },
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body, amount_cents) values ($1, $2, 'over', 9007199254740992)",
        values: [ORG, PRJ],
      },
    ]);
    app = await open.app(db.app);
  });

  it('come back as numbers up to 2^53 - 1', async () => {
    expect(
      await withTenant(app, A, (tx) =>
        one(
          tx,
          sql<{
            amount_cents: unknown;
          }>`select amount_cents from app.fixture_notes where body = 'max'`,
        ),
      ),
    ).toEqual({ amount_cents: 9007199254740991 });
    expect(
      await withTenant(app, A, (tx) =>
        one(tx, sql<{ n: unknown }>`select -9007199254740991::bigint as n`),
      ),
    ).toEqual({
      n: -9007199254740991,
    });
    expect(
      await withTenant(app, A, (tx) =>
        one(tx, sql<{ n: unknown }>`select count(*) as n from app.fixture_notes`),
      ),
    ).toEqual({ n: 2 });
  });

  it('raise INTEGER_INVALID above 2^53 - 1 instead of losing precision', async () => {
    const error = await rejected(
      withTenant(app, A, (tx) =>
        rows(tx, sql`select amount_cents from app.fixture_notes where body = 'over'`),
      ),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('INTEGER_INVALID');
    expect((error as DbError).message).not.toContain('9007199254740992');
  });

  it.each(['9007199254740992', '-9007199254740992', '9223372036854775807'])(
    'raise INTEGER_INVALID for the literal %s',
    async (literal) => {
      const error = await rejected(
        withTenant(app, A, (tx) => rows(tx, sql`select ${sql.raw(literal)}::bigint as n`)),
      );
      expect((error as DbError).code).toBe('INTEGER_INVALID');
    },
  );

  it('parse bigint arrays the same way', async () => {
    expect(
      await withTenant(app, A, (tx) =>
        one(tx, sql<{ a: unknown }>`select array[1, 2, null]::bigint[] as a`),
      ),
    ).toEqual({
      a: [1, 2, null],
    });
    const error = await rejected(
      withTenant(app, A, (tx) => rows(tx, sql`select array[1, 9007199254740992]::bigint[] as a`)),
    );
    expect((error as DbError).code).toBe('INTEGER_INVALID');
  });

  it('keep null as null', async () => {
    expect(
      await withTenant(app, A, (tx) => one(tx, sql<{ n: unknown }>`select null::bigint as n`)),
    ).toEqual({ n: null });
  });

  it('refuse a fraction sent for a bigint column', async () => {
    const error = await rejected(
      withTenant(app, { organizationId: ORG, projectId: PRJ }, (tx) =>
        sql`insert into app.fixture_notes (organization_id, project_id, body, amount_cents) values (${ORG}, ${PRJ}, 'frac', ${'1.5'})`.execute(
          tx,
        ),
      ),
    );
    expect(error).toBeInstanceOf(Error);
  });
});
