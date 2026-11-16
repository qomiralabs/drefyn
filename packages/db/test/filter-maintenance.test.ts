import { describe, expect, it, vi } from 'vitest';
import {
  bloatPercent,
  filterRowAlerts,
  maintainFilterRows,
  planMaintenance,
  runMaintain,
  type FilterMaintenanceSession,
  type FilterRowFacts,
} from '../src/filter-maintenance.ts';

const facts = (over: Partial<FilterRowFacts> = {}): FilterRowFacts => ({
  deadTuples: 0,
  oldestTransactionSeconds: 0,
  heapBytes: 365,
  indexBytes: 345,
  ...over,
});

const scripted = (over: Partial<FilterRowFacts> = {}, held = true) => {
  const sent: string[] = [];
  const session: FilterMaintenanceSession = {
    query: (text) => {
      sent.push(text);
      if (text.includes('pg_try_advisory_lock')) return Promise.resolve({ rows: [{ held }] });
      if (text.includes('dead_tuples')) {
        const f = facts(over);
        return Promise.resolve({
          rows: [
            {
              dead_tuples: f.deadTuples,
              oldest_seconds: f.oldestTransactionSeconds,
              heap_bytes: f.heapBytes,
              index_bytes: f.indexBytes,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { session, sent };
};

describe('bloatPercent', () => {
  it('reads a fresh key as none and the loose key of an import as bloated', () => {
    expect(bloatPercent(facts())).toBe(0);
    expect(bloatPercent(facts({ indexBytes: 608 }))).toBe(40);
  });

  it('reads an empty table as none', () => {
    expect(bloatPercent(facts({ heapBytes: 0, indexBytes: 0 }))).toBe(0);
  });
});

describe('planMaintenance', () => {
  it('rebuilds only past 30 percent', () => {
    expect(planMaintenance(facts({ heapBytes: 70, indexBytes: 100 }), false).reindex).toBe(false);
    expect(planMaintenance(facts({ heapBytes: 69, indexBytes: 100 }), false).reindex).toBe(true);
  });

  it('after an import vacuums, with analyze, and rebuilds whatever the bloat', () => {
    expect(planMaintenance(facts(), true)).toEqual({ vacuum: true, reindex: true });
    expect(planMaintenance(facts(), false)).toEqual({ vacuum: false, reindex: false });
  });
});

describe('filterRowAlerts', () => {
  it('alerts past 5 minutes of open transaction, and not at it', () => {
    expect(filterRowAlerts(facts({ oldestTransactionSeconds: 300 }))).toEqual([]);
    expect(filterRowAlerts(facts({ oldestTransactionSeconds: 301 }))).toEqual([
      'engine.filter_rows.old_transaction',
    ]);
  });

  it('alerts on dead tuples', () => {
    expect(filterRowAlerts(facts({ deadTuples: 20_000 }))).toEqual([]);
    expect(filterRowAlerts(facts({ deadTuples: 20_001 }))).toEqual([
      'engine.filter_rows.dead_tuples',
    ]);
  });
});

describe('maintainFilterRows', () => {
  it('vacuums with analyze, never analyze alone, before a rebuild', async () => {
    const { session, sent } = scripted();
    const report = await maintainFilterRows(session, true);
    const work = sent.filter((text) => /^(vacuum|reindex|analyze)/.test(text));
    expect(work).toEqual([
      'vacuum (analyze) app.nodes',
      'vacuum (analyze) app.node_filter_rows',
      'reindex index concurrently app.node_filter_rows_pkey',
    ]);
    expect(report).toMatchObject({ ran: true, vacuum: true, reindex: true });
  });

  it('stands aside when another run holds the lock', async () => {
    const { session, sent } = scripted({ indexBytes: 900 }, false);
    const report = await maintainFilterRows(session, false);
    expect(report).toMatchObject({ ran: false, reindex: false, bloat_percent: 59 });
    expect(sent.some((text) => text.startsWith('reindex'))).toBe(false);
    expect(sent.some((text) => text.includes('advisory_unlock'))).toBe(false);
  });

  it('drops what a failed rebuild leaves, and lets the lock go', async () => {
    const { session, sent } = scripted({ indexBytes: 900 });
    const query = session.query.bind(session);
    const failing: FilterMaintenanceSession = {
      query: (text) => {
        if (text.startsWith('reindex')) {
          sent.push(text);
          return Promise.reject(new Error('canceled'));
        }
        return query(text);
      },
    };
    await expect(maintainFilterRows(failing, false)).rejects.toThrow('canceled');
    expect(sent).toContain('drop index concurrently if exists app.node_filter_rows_pkey_ccnew');
    expect(sent.at(-1)).toContain('pg_advisory_unlock');
  });
});

describe('runMaintain', () => {
  const output = () => {
    const lines: string[] = [];
    return { lines, stream: { write: (text: string) => lines.push(text) } };
  };

  it.each([[['maintain']], [['maintain', 'x']], [['maintain', 'filter-rows', '--now']]])(
    'prints the usage for %j',
    async (argv) => {
      const err = output();
      const code = await runMaintain({
        argv,
        env: {},
        stdout: output().stream,
        stderr: err.stream,
      });
      expect(code).toBe(2);
      expect(err.lines.join('')).toContain('usage: drefyn maintain filter-rows');
    },
  );

  it('prints one line of counts and closes the session', async () => {
    const { session } = scripted();
    const end = vi.fn(() => Promise.resolve());
    const out = output();
    const code = await runMaintain({
      argv: ['maintain', 'filter-rows'],
      env: {},
      stdout: out.stream,
      stderr: output().stream,
      connect: () => Promise.resolve({ ...session, end }),
    });
    expect(code).toBe(0);
    expect(end).toHaveBeenCalledOnce();
    expect(JSON.parse(out.lines.join(''))).toMatchObject({
      event: 'engine.filter_rows.maintenance',
      ran: true,
    });
  });

  it('reports a failure by code, never by server text', async () => {
    const err = output();
    const code = await runMaintain({
      argv: ['maintain', 'filter-rows', '--after-import'],
      env: {},
      stdout: output().stream,
      stderr: err.stream,
      connect: () =>
        Promise.reject(Object.assign(new Error('value quoted here'), { code: '57014' })),
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toBe('drefyn maintain: failed (57014)\n');
  });
});
