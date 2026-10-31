import fc from 'fast-check';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import type { Responder } from './scripted-store.ts';
import {
  NEW_SESSION,
  OTHER_USER,
  USER,
  browser,
  isDelete,
  isInsert,
  isLock,
  sessionInfo,
  setup,
} from './session-fixtures.ts';
import { anyUuid, runs } from './support.ts';

interface ModelRow {
  readonly id: string;
  readonly user_id: string;
  readonly live: boolean;
  readonly recent: boolean;
}

// A sessions table the scripted statements act on, as Postgres would under the user's RLS
// context: the lock reads the user's rows, the insert copies the named row under a new id,
// the delete removes every row of the user but the one it names.
function model(rows: ModelRow[], user: string): Responder {
  return (statement) => {
    const mine = () => rows.filter((r) => r.user_id === user);
    if (isLock(statement)) {
      return mine()
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({ id: r.id, live: r.live, recent: r.recent, seconds_left: 1000 }));
    }
    if (isInsert(statement)) {
      const from = mine().find((r) => r.id === statement.parameters[1]);
      if (from === undefined) return [];
      rows.push({ ...from, id: NEW_SESSION });
      return [{ id: NEW_SESSION }];
    }
    if (isDelete(statement)) {
      const keep = statement.parameters[0];
      const gone = mine().filter((r) => r.id !== keep);
      for (const r of gone) rows.splice(rows.indexOf(r), 1);
      return gone.map((r) => ({ id: r.id }));
    }
    return [];
  };
}

const row = (user: string) =>
  fc.record({
    id: anyUuid.filter((u) => u !== NEW_SESSION),
    user_id: fc.constant(user),
    live: fc.boolean(),
    recent: fc.boolean(),
  });

const table = fc
  .tuple(
    fc.uniqueArray(row(USER), { selector: (r) => r.id, maxLength: 6 }),
    fc.uniqueArray(row(OTHER_USER), { selector: (r) => r.id, maxLength: 3 }),
  )
  .filter(([a, b]) => a.every((r) => b.every((o) => o.id !== r.id)));

describe('signOutOtherSessions over any table', () => {
  it('leaves exactly one live row with a new id on success, and the table unchanged otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(table, fc.nat(), async ([mine, theirs], pick) => {
        const rows: ModelRow[] = [...mine, ...theirs];
        const before = JSON.stringify(rows);
        // The current row is one of the user's, or a row the database no longer has.
        const current =
          mine[pick % (mine.length + 1)]?.id ?? '01890a5d-ac96-774b-bcce-b3020990ffff';
        const { sessions } = setup(model(rows, USER));
        const result = await sessions.signOutOtherSessions(
          sessionInfo({ sessionId: idOf('ses', current) }),
          browser(),
        );
        const left = rows.filter((r) => r.user_id === USER);
        const theirsAfter = rows.filter((r) => r.user_id === OTHER_USER);
        expect(theirsAfter).toEqual(theirs);
        const held = mine.find((r) => r.id === current);
        if (held?.live === true && held.recent) {
          expect(result).toMatchObject({ ok: true, value: { revoked: mine.length - 1 } });
          expect(left.map((r) => r.id)).toEqual([NEW_SESSION]);
          expect(mine.some((r) => r.id === NEW_SESSION)).toBe(false);
        } else {
          expect(result.ok).toBe(false);
          expect(JSON.stringify(rows)).toBe(before);
        }
      }),
      runs,
    );
  });
});
