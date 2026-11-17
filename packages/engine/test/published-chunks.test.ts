import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LATEST_LABEL,
  termChange,
  writePublishedChunks,
  type ChunkTarget,
} from '../src/published-chunks.ts';
import { scriptedStore, type Statement } from './support/scripted-store.ts';

const TENANT: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a0001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a0002'),
};
const NODE = '01890a5d-ac96-774b-bcce-b302099a0003';
const VERSION = '01890a5d-ac96-774b-bcce-b302099a0004';

const id = (n: number) => `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`;

interface Script {
  readonly before?: readonly { id: string; visibility: string }[];
  readonly copied?: readonly { id: string; visibility: string }[];
  readonly moved?: { removed: string; added: string; lexemes: string } | null;
}

// Answers each statement by what it is, so a test reads as the rows the database would hold.
function run(script: Script, target: ChunkTarget | null) {
  const { store, statements } = scriptedStore((statement: Statement) => {
    const text = statement.sql;
    if (text.includes('with gone as')) return script.moved === null ? [] : [script.moved ?? {}];
    if (text.includes('insert into app.published_chunks')) return script.copied ?? [];
    if (/^\s*select id::text as id, visibility from app\.published_chunks/.test(text)) {
      return script.before ?? [];
    }
    return [];
  });
  const done = store.tenant(TENANT, (tx) => writePublishedChunks(tx, TENANT, NODE, target));
  return { done, statements };
}

const kinds = (statements: readonly Statement[]) =>
  statements.map(({ sql }) => {
    if (sql.includes('with gone as')) return 'terms';
    if (sql.includes('pg_advisory_xact_lock')) return 'lock';
    if (sql.includes('insert into app.published_project_term_totals')) return 'totals';
    if (sql.includes('insert into app.published_chunks')) return 'copy';
    if (sql.includes('update app.published_chunks set is_current = false')) return 'flip';
    if (sql.includes('from app.published_chunks')) return 'before';
    return sql.trim().split(/\s+/)[0] ?? '';
  });

const PUBLIC: ChunkTarget = { versionId: VERSION, visibility: 'public' };

describe('termChange', () => {
  it('keeps a chunk that stays public and current, and moves the rest', () => {
    expect(termChange([id(1), id(2)], [id(2), id(3)])).toEqual({ gone: [id(1)], added: [id(3)] });
  });

  it('never lists a chunk as both gone and added, and loses none', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 30 }).map(id)),
        fc.uniqueArray(fc.integer({ min: 0, max: 30 }).map(id)),
        (before, after) => {
          const { gone, added } = termChange(before, after);
          expect(gone.filter((g) => added.includes(g))).toEqual([]);
          const kept = before.filter((b) => after.includes(b));
          expect(new Set([...kept, ...gone])).toEqual(new Set(before));
          expect(new Set([...kept, ...added])).toEqual(new Set(after));
          expect(gone).toEqual([...gone].sort());
          expect(added).toEqual([...added].sort());
        },
      ),
    );
  });
});

describe('writePublishedChunks', () => {
  it('copies, then locks the project, then moves postings and counts in one statement', async () => {
    const { done, statements } = run(
      {
        copied: [
          { id: id(1), visibility: 'public' },
          { id: id(2), visibility: 'public' },
        ],
        moved: { removed: '0', added: '7', lexemes: '5' },
      },
      PUBLIC,
    );
    expect(await done).toEqual({
      chunks: 2,
      publicChunks: 2,
      postingsAdded: 7,
      postingsRemoved: 0,
      lexemesChanged: 5,
    });
    expect(kinds(statements)).toEqual(['before', 'flip', 'copy', 'lock', 'totals', 'terms']);
    const terms = statements.find((s) => s.sql.includes('with gone as'));
    expect(terms?.parameters).toContainEqual([]);
    expect(terms?.parameters).toContainEqual([id(1), id(2)]);
    expect(terms?.parameters).toContain(LATEST_LABEL);
    const lock = statements.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.parameters).toEqual([`engine.terms:${TENANT.organizationId}:${TENANT.projectId}`]);
  });

  it('writes protected chunks but no term rows, and takes no lock when nothing public moves', async () => {
    const { done, statements } = run(
      { copied: [{ id: id(1), visibility: 'protected' }] },
      { versionId: VERSION, visibility: 'protected' },
    );
    expect(await done).toEqual({
      chunks: 1,
      publicChunks: 0,
      postingsAdded: 0,
      postingsRemoved: 0,
      lexemesChanged: 0,
    });
    expect(kinds(statements)).toEqual(['before', 'flip', 'copy']);
    const copy = statements.find((s) => s.sql.includes('insert into app.published_chunks'));
    expect(copy?.parameters).toContain('protected');
  });

  it('removes the postings of a tightened page', async () => {
    const { done, statements } = run(
      {
        before: [
          { id: id(1), visibility: 'public' },
          { id: id(2), visibility: 'public' },
        ],
        copied: [
          { id: id(1), visibility: 'protected' },
          { id: id(2), visibility: 'protected' },
        ],
        moved: { removed: '9', added: '0', lexemes: '4' },
      },
      { versionId: VERSION, visibility: 'protected' },
    );
    expect(await done).toMatchObject({ publicChunks: 0, postingsRemoved: 9, lexemesChanged: 4 });
    const terms = statements.find((s) => s.sql.includes('with gone as'));
    expect(terms?.parameters).toContainEqual([id(1), id(2)]);
    expect(terms?.parameters).toContain(-2);
  });

  it('leaves the postings of a republish of the same public version alone', async () => {
    const rows = [{ id: id(1), visibility: 'public' }];
    const { done, statements } = run({ before: rows, copied: rows }, PUBLIC);
    expect(await done).toMatchObject({ chunks: 1, postingsAdded: 0, postingsRemoved: 0 });
    expect(kinds(statements)).toEqual(['before', 'flip', 'copy']);
  });

  it('unpublishes: flips every current row, copies nothing and removes the postings', async () => {
    const { done, statements } = run(
      {
        before: [{ id: id(1), visibility: 'public' }],
        moved: { removed: '3', added: '0', lexemes: '3' },
      },
      null,
    );
    expect(await done).toEqual({
      chunks: 0,
      publicChunks: 0,
      postingsAdded: 0,
      postingsRemoved: 3,
      lexemesChanged: 3,
    });
    expect(kinds(statements)).toEqual(['before', 'flip', 'lock', 'totals', 'terms']);
    const flip = statements.find((s) => s.sql.includes('set is_current = false'));
    expect(flip?.sql).not.toContain('version_id <>');
  });

  it('flips only the other versions when a version is published', async () => {
    const { done, statements } = run({ copied: [] }, PUBLIC);
    await done;
    const flip = statements.find((s) => s.sql.includes('set is_current = false'));
    expect(flip?.sql).toContain('version_id <>');
    expect(flip?.parameters).toContain(VERSION);
  });

  it('reads missing counts as zero', async () => {
    const { done } = run({ copied: [{ id: id(1), visibility: 'public' }], moved: null }, PUBLIC);
    expect(await done).toMatchObject({ postingsAdded: 0, postingsRemoved: 0, lexemesChanged: 0 });
  });
});
