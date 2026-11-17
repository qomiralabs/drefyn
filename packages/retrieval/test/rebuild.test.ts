import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { createTermRebuild } from '../src/index.ts';
import { capturedLogger, scriptedTermStore, type Statement } from './support/scripted.ts';

const TENANT: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a0001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a0002'),
};

const kind = ({ sql }: Statement) => {
  if (sql.includes('pg_advisory_xact_lock')) return 'lock';
  if (/delete from app\.published_chunk_terms/.test(sql)) return 'clear postings';
  if (/delete from app\.published_term_stats/.test(sql)) return 'clear stats';
  if (/delete from app\.published_project_term_totals/.test(sql)) return 'clear totals';
  if (/insert into app\.published_chunk_terms/.test(sql)) return 'postings';
  if (/insert into app\.published_term_stats/.test(sql)) return 'stats';
  if (/insert into app\.published_project_term_totals/.test(sql)) return 'totals';
  return 'other';
};

describe('rebuildTermStats', () => {
  it('locks the project as publish does, clears, then recomputes the three tables', async () => {
    const { store, statements, tenants, ends } = scriptedTermStore((statement) => {
      const k = kind(statement);
      if (k === 'postings') return [{ n: 40 }];
      if (k === 'stats') return [{ n: 12 }];
      if (k === 'totals') return [{ n: 5 }];
      return [];
    });
    const log = capturedLogger();
    const rebuild = createTermRebuild({ store, logger: log.logger });
    expect(await rebuild.rebuildTermStats(TENANT)).toEqual({
      ok: true,
      value: { chunks: 5, lexemes: 12 },
    });
    expect(statements.map(kind)).toEqual([
      'lock',
      'clear postings',
      'clear stats',
      'clear totals',
      'postings',
      'stats',
      'totals',
    ]);
    expect(tenants).toEqual([TENANT]);
    expect(ends).toEqual(['commit']);
    // Same lock name as the publish writer, so a rebuild and a publish never interleave.
    expect(statements[0]?.parameters).toEqual([
      `engine.terms:${TENANT.organizationId}:${TENANT.projectId}`,
    ]);
    for (const statement of statements.slice(1)) {
      expect(statement.parameters).toEqual(
        expect.arrayContaining([TENANT.organizationId, TENANT.projectId]),
      );
    }
    const inserts = statements.filter((s) => s.sql.includes('insert into'));
    for (const insert of inserts) expect(insert.sql).toContain("'public'");
    expect(statements.find((s) => kind(s) === 'postings')?.sql).toMatch(
      /is_current\s+and c\.visibility = 'public'/,
    );
    expect(log.lines).toEqual([
      {
        level: 'info',
        event: 'retrieval.term_rebuild',
        fields: {
          organizationId: TENANT.organizationId,
          projectId: TENANT.projectId,
          chunks: 5,
          lexemes: 12,
          postings: 40,
          ms: expect.any(Number) as number,
        },
      },
    ]);
  });

  it('is unavailable when the write fails, and rolls back', async () => {
    const { store, ends } = scriptedTermStore((statement) => {
      if (kind(statement) === 'stats') throw new Error('disk full');
      return [{ n: 1 }];
    });
    const log = capturedLogger();
    const rebuild = createTermRebuild({ store, logger: log.logger });
    expect(await rebuild.rebuildTermStats(TENANT)).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
    expect(ends).toEqual(['rollback']);
    expect(log.lines.map((l) => [l.level, l.event])).toEqual([
      ['warn', 'retrieval.term_rebuild_failed'],
    ]);
  });

  it('runs with no logger', async () => {
    const { store } = scriptedTermStore(() => [{ n: 0 }]);
    expect(await createTermRebuild({ store }).rebuildTermStats(TENANT)).toEqual({
      ok: true,
      value: { chunks: 0, lexemes: 0 },
    });
  });
});
