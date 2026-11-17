import { DbError } from '@drefyn/db';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createRetrieval,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
  type RetrievalFlags,
} from '../src/index.ts';
import {
  capturedLogger,
  scriptedReader,
  type Responder,
  type Statement,
} from './support/scripted.ts';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`;

const TENANT: TenantRef = {
  organizationId: organizationId(uuid(1)),
  projectId: projectId(uuid(2)),
};
const OTHER_ORG: TenantRef = {
  organizationId: organizationId(uuid(3)),
  projectId: projectId(uuid(4)),
};

const PUBLISHED_AT = new Date('2026-11-17T10:00:00.000Z');
const QUERY = 'how do I rotate a canary-query-text key';
const BODY = 'canary-body-text Rotate keys from the settings page.';

const hit = (n: number, score: number) => ({
  chunk_id: uuid(100 + n),
  node_id: uuid(200 + n),
  version_id: uuid(300 + n),
  path: `/guides/page-${String(n)}`,
  title: `Page ${String(n)}`,
  heading_path: ['Guides', `Page ${String(n)}`],
  text: `${BODY} ${String(n)}`,
  score,
});

interface SearchAnswer {
  readonly chunkCount?: string | null;
  readonly publishedAt?: Date | null;
  readonly coverage?: number | null;
  readonly hits?: readonly ReturnType<typeof hit>[];
}

const searchRow = (answer: SearchAnswer = {}) => ({
  chunk_count: answer.chunkCount === undefined ? '120' : answer.chunkCount,
  lexemes: 5,
  candidates: 2,
  postings: 7,
  published_at: answer.publishedAt === undefined ? PUBLISHED_AT : answer.publishedAt,
  coverage: answer.coverage === undefined ? null : answer.coverage,
  hits: answer.hits ?? [hit(1, 2.5), hit(2, 1.25)],
});

const kind = (statement: Statement) => {
  if (statement.sql.includes('plan_cache_mode')) return 'prepare';
  if (statement.sql.includes('published_chunk_terms')) return 'search';
  if (statement.sql.includes('with page as')) return 'page';
  return 'other';
};

const answering =
  (
    search: () => Record<string, unknown>,
    page: () => readonly Record<string, unknown>[] = () => [],
  ) =>
  (statement: Statement) => {
    const k = kind(statement);
    if (k === 'search') return [search()];
    if (k === 'page') return page();
    return [];
  };

const on: RetrievalFlags = { evaluate: () => Promise.resolve({ value: true }) };
const off: RetrievalFlags = { evaluate: () => Promise.resolve({ value: false }) };
const broken: RetrievalFlags = {
  evaluate: () => Promise.resolve({ value: false, errorCode: 'FLAG_TIMEOUT' }),
};
const throwing: RetrievalFlags = { evaluate: () => Promise.reject(new Error('flagd gone')) };

function build(
  respond: Responder,
  options: {
    flags?: RetrievalFlags;
    config?: Partial<RetrievalConfig>;
  } = {},
) {
  const scripted = scriptedReader(respond);
  const log = capturedLogger();
  const observed: { name: string; value: number; labels: Record<string, string> }[] = [];
  const retrieval = createRetrieval({
    reader: scripted.reader,
    config: { ...DEFAULT_RETRIEVAL_CONFIG, ...options.config },
    flags: options.flags ?? on,
    logger: log.logger,
    metrics: {
      observe: (name, value, labels) => {
        observed.push({ name, value, labels: { ...labels } });
      },
    },
  });
  return { retrieval, ...scripted, ...log, observed };
}

const textIn = (value: unknown) => JSON.stringify(value);

describe('retrieve', () => {
  it('returns hits with 1 based ranks, the pin and lexical ranking, and no scores', async () => {
    const { retrieval, statements, calls } = build(answering(() => searchRow()));
    const result = await retrieval.retrieve(TENANT, { query: QUERY });
    expect(result).toEqual({
      ok: true,
      value: {
        pin: { version: 'latest', publishedAt: '2026-11-17T10:00:00.000Z' },
        ranking: 'lexical',
        hits: [1, 2].map((n, at) => ({
          chunkId: uuid(100 + n),
          nodeId: uuid(200 + n),
          versionId: uuid(300 + n),
          path: `/guides/page-${String(n)}`,
          title: `Page ${String(n)}`,
          headingPath: ['Guides', `Page ${String(n)}`],
          text: `${BODY} ${String(n)}`,
          rank: at + 1,
        })),
      },
    });
    expect(textIn(result)).not.toContain('score');
    expect(statements.map(kind)).toEqual(['prepare', 'search']);
    expect(calls).toEqual([{ tenant: TENANT, timeoutMs: 1500 }]);
  });

  it('sets the plan mode and the timeout locally before the one statement', async () => {
    const { retrieval, statements } = build(
      answering(() => searchRow()),
      {
        config: { timeoutMs: 900 },
      },
    );
    await retrieval.retrieve(TENANT, { query: QUERY });
    const [prepare, search] = statements;
    expect(prepare?.sql).toContain("set_config('plan_cache_mode', 'force_custom_plan', true)");
    expect(prepare?.sql).toContain("set_config('statement_timeout'");
    expect(prepare?.parameters).toEqual(['900']);
    expect(search?.sql).not.toMatch(/ts_rank/);
    expect(search?.sql).not.toMatch(/to_tsquery|websearch_to_tsquery|plainto_tsquery/);
  });

  it('sends the tenant, the label, the query and every cap as parameters', async () => {
    const { retrieval, statements } = build(
      answering(() => searchRow()),
      {
        config: {
          maxQueryTerms: 11,
          commonTermPercent: 33,
          maxPostings: 4444,
          maxScoredCandidates: 222,
        },
      },
    );
    await retrieval.retrieve(TENANT, { query: QUERY, limit: 3, pathPrefix: '/guides' });
    const search = statements.find((s) => kind(s) === 'search');
    expect(search?.parameters).toEqual(
      expect.arrayContaining([
        TENANT.organizationId,
        TENANT.projectId,
        'latest',
        QUERY,
        11,
        33,
        4444,
        222,
        3,
        '/guides',
      ]),
    );
    expect(search?.sql).not.toContain(QUERY);
  });

  it('returns no hits and no error for a query with no lexemes', async () => {
    const { retrieval } = build(answering(() => searchRow({ hits: [] })));
    const result = await retrieval.retrieve(TENANT, { query: '?!' });
    expect(result).toMatchObject({ ok: true, value: { hits: [] } });
  });

  it('is version_not_found when nothing is published for latest', async () => {
    const { retrieval } = build(
      answering(() => searchRow({ publishedAt: null, chunkCount: null, hits: [] })),
    );
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toEqual({
      ok: false,
      error: 'retrieval.version_not_found',
    });
  });

  it('is version_not_found for any label but latest, without a read', async () => {
    const { retrieval, statements } = build(answering(() => searchRow()));
    expect(await retrieval.retrieve(TENANT, { query: QUERY, version: 'v1' })).toEqual({
      ok: false,
      error: 'retrieval.version_not_found',
    });
    expect(statements).toEqual([]);
  });

  it('is bad_input for input it cannot parse, without a read', async () => {
    const { retrieval, statements } = build(answering(() => searchRow()));
    expect(await retrieval.retrieve(TENANT, { query: '' })).toEqual({
      ok: false,
      error: 'retrieval.bad_input',
    });
    expect(await retrieval.retrieve(TENANT, { query: 'a', limit: 99 })).toEqual({
      ok: false,
      error: 'retrieval.bad_input',
    });
    expect(statements).toEqual([]);
  });

  it('accepts a timestamp string from the driver for the pin', async () => {
    const { retrieval } = build(
      answering(() => ({ ...searchRow(), published_at: '2026-11-17T10:00:00Z' })),
    );
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toMatchObject({
      ok: true,
      value: { pin: { publishedAt: '2026-11-17T10:00:00.000Z' } },
    });
  });

  it('treats a row it does not recognise as unavailable', async () => {
    const { retrieval, lines } = build(answering(() => ({ ...searchRow(), hits: [{ x: 1 }] })));
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
    expect(lines.some((l) => l.event === 'retrieval.read_failed' && l.level === 'warn')).toBe(true);
  });
});

describe('retrieveScored', () => {
  it('returns the same hits plus coverage from the same statement', async () => {
    const { retrieval, statements } = build(answering(() => searchRow({ coverage: 0.4 })));
    const plain = await retrieval.retrieve(TENANT, { query: QUERY });
    const scored = await retrieval.retrieveScored(TENANT, { query: QUERY });
    expect(scored.ok && plain.ok).toBe(true);
    if (!scored.ok || !plain.ok) return;
    expect(scored.value.hits).toEqual(plain.value.hits);
    expect(scored.value.coverage).toBe(0.4);
    const searches = statements.filter((s) => kind(s) === 'search');
    expect(searches).toHaveLength(2);
    expect(searches[0]?.sql).not.toContain('coverage_lexeme');
    expect(searches[1]?.sql).toContain('coverage_lexeme');
  });

  it('reports coverage 0 with no hits', async () => {
    const { retrieval } = build(answering(() => searchRow({ hits: [], coverage: null })));
    expect(await retrieval.retrieveScored(TENANT, { query: QUERY })).toMatchObject({
      ok: true,
      value: { coverage: 0, hits: [] },
    });
  });
});

describe('failures', () => {
  it.each([
    [new DbError('DB_TIMEOUT', 'statement timeout'), 'retrieval.busy'],
    [new DbError('DB_UNAVAILABLE', 'connection refused'), 'retrieval.unavailable'],
    [new DbError('DB_RLS_VIOLATION', 'no'), 'retrieval.unavailable'],
    [new Error('socket hang up'), 'retrieval.unavailable'],
  ])('maps %s to %s with no partial result', async (error, code) => {
    const { retrieval, lines } = build((statement) => {
      if (kind(statement) === 'search') throw error;
      return [];
    });
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toEqual({ ok: false, error: code });
    const warned = lines.find((l) => l.level === 'warn');
    expect(warned?.fields).toMatchObject({
      organizationId: TENANT.organizationId,
      projectId: TENANT.projectId,
      code,
    });
  });

  it('maps a failure in getPage and listVersions the same way', async () => {
    const { retrieval } = build(() => {
      throw new DbError('DB_TIMEOUT', 'statement timeout');
    });
    expect(await retrieval.getPage(TENANT, { path: '/a' })).toEqual({
      ok: false,
      error: 'retrieval.busy',
    });
  });

  it('refuses past the in flight limit for one organization, and frees the slot after', async () => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scripted = scriptedReader(answering(() => searchRow()));
    const retrieval = createRetrieval({
      reader: {
        read: async (tenant, timeoutMs, work) => {
          if (tenant.organizationId === TENANT.organizationId) {
            entered();
            await held;
          }
          return scripted.reader.read(tenant, timeoutMs, work);
        },
      },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, maxInFlight: 1 },
      flags: on,
    });
    const first = retrieval.retrieve(TENANT, { query: QUERY });
    // The first one holds its slot from here until release.
    await reached;
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toEqual({
      ok: false,
      error: 'retrieval.busy',
    });
    expect(await retrieval.getPage(TENANT, { path: '/x' })).toEqual({
      ok: false,
      error: 'retrieval.busy',
    });
    // Another organization has its own budget.
    expect((await retrieval.retrieve(OTHER_ORG, { query: QUERY })).ok).toBe(true);
    release();
    expect((await first).ok).toBe(true);
    expect((await retrieval.retrieve(TENANT, { query: QUERY })).ok).toBe(true);
  });

  it('frees the slot when the read fails', async () => {
    let fail = true;
    const { retrieval } = build(
      (statement) => {
        if (kind(statement) === 'search' && fail) throw new Error('boom');
        return kind(statement) === 'search' ? [searchRow()] : [];
      },
      { config: { maxInFlight: 1 } },
    );
    expect((await retrieval.retrieve(TENANT, { query: QUERY })).ok).toBe(false);
    fail = false;
    expect((await retrieval.retrieve(TENANT, { query: QUERY })).ok).toBe(true);
  });
});

describe('the retrieval.v1 flag', () => {
  it('off: every call is not_found and nothing is read', async () => {
    const { retrieval, statements } = build(
      answering(() => searchRow()),
      { flags: off },
    );
    const results = await Promise.all([
      retrieval.retrieve(TENANT, { query: QUERY }),
      retrieval.retrieveScored(TENANT, { query: QUERY }),
      retrieval.getPage(TENANT, { path: '/guides/page-1' }),
      retrieval.listVersions(TENANT),
    ]);
    for (const result of results)
      expect(result).toEqual({ ok: false, error: 'retrieval.not_found' });
    expect(statements).toEqual([]);
  });

  it('off wins over bad input', async () => {
    const { retrieval } = build(
      answering(() => searchRow()),
      { flags: off },
    );
    expect(await retrieval.retrieve(TENANT, { query: '' })).toEqual({
      ok: false,
      error: 'retrieval.not_found',
    });
  });

  it('asks with the tenant', async () => {
    const asked: unknown[] = [];
    const { retrieval } = build(
      answering(() => searchRow()),
      {
        flags: {
          evaluate: (name, context) => {
            asked.push({ name, context });
            return Promise.resolve({ value: true });
          },
        },
      },
    );
    await retrieval.retrieve(TENANT, { query: QUERY });
    expect(asked).toEqual([
      {
        name: 'retrieval.v1',
        context: { organizationId: TENANT.organizationId, projectId: TENANT.projectId },
      },
    ]);
  });

  it.each([
    ['answers with an error code', broken],
    ['throws', throwing],
  ])('a read that %s fails closed as unavailable', async (_name, flags) => {
    const { retrieval, statements, lines } = build(
      answering(() => searchRow()),
      { flags },
    );
    expect(await retrieval.retrieve(TENANT, { query: QUERY })).toEqual({
      ok: false,
      error: 'retrieval.unavailable',
    });
    expect(statements).toEqual([]);
    expect(lines.some((l) => l.event === 'retrieval.flag_read_failed')).toBe(true);
  });
});

describe('getPage', () => {
  const pageRows = () => [
    {
      node_id: uuid(201),
      version_id: uuid(301),
      path: '/guides/page-1',
      title: 'Page 1',
      heading_path: ['Guides'],
      text: 'First',
      published_at: PUBLISHED_AT,
    },
    {
      node_id: uuid(201),
      version_id: uuid(301),
      path: '/guides/page-1',
      title: 'Page 1',
      heading_path: ['Guides', 'More'],
      text: 'Second',
      published_at: PUBLISHED_AT,
    },
  ];

  it('returns the sections in order with the pin', async () => {
    const { retrieval, statements } = build(answering(() => searchRow(), pageRows));
    expect(await retrieval.getPage(TENANT, { path: '/guides/page-1' })).toEqual({
      ok: true,
      value: {
        pin: { version: 'latest', publishedAt: '2026-11-17T10:00:00.000Z' },
        nodeId: uuid(201),
        versionId: uuid(301),
        path: '/guides/page-1',
        title: 'Page 1',
        sections: [
          { headingPath: ['Guides'], text: 'First' },
          { headingPath: ['Guides', 'More'], text: 'Second' },
        ],
      },
    });
    expect(statements.map(kind)).toEqual(['prepare', 'page']);
    expect(statements[1]?.parameters).toContain('/guides/page-1');
  });

  it('reads by node id', async () => {
    const { retrieval, statements } = build(answering(() => searchRow(), pageRows));
    expect((await retrieval.getPage(TENANT, { nodeId: uuid(201) })).ok).toBe(true);
    expect(statements[1]?.parameters).toContain(uuid(201));
    expect(statements[1]?.sql).toContain('node_id =');
  });

  it('is not_found when the reader sees no rows', async () => {
    const { retrieval } = build(
      answering(
        () => searchRow(),
        () => [],
      ),
    );
    expect(await retrieval.getPage(TENANT, { path: '/nope' })).toEqual({
      ok: false,
      error: 'retrieval.not_found',
    });
  });

  it('is bad_input without exactly one of path and node id, and version_not_found on a label', async () => {
    const { retrieval, statements } = build(answering(() => searchRow(), pageRows));
    expect(await retrieval.getPage(TENANT, {})).toEqual({
      ok: false,
      error: 'retrieval.bad_input',
    });
    expect(await retrieval.getPage(TENANT, { path: '/a', nodeId: uuid(1) })).toEqual({
      ok: false,
      error: 'retrieval.bad_input',
    });
    expect(await retrieval.getPage(TENANT, { path: '/a', version: 'v2' })).toEqual({
      ok: false,
      error: 'retrieval.version_not_found',
    });
    expect(statements).toEqual([]);
  });
});

describe('listVersions', () => {
  it('lists latest as the default until named versions exist', async () => {
    const { retrieval, statements } = build(answering(() => searchRow()));
    expect(await retrieval.listVersions(TENANT)).toEqual({
      ok: true,
      value: { versions: [{ label: 'latest', isDefault: true, deprecated: false }] },
    });
    expect(statements).toEqual([]);
  });
});

describe('logs and metrics', () => {
  it('log ids, counts and timing, never the query or the text', async () => {
    const { retrieval, lines, observed } = build(answering(() => searchRow()));
    await retrieval.retrieve(TENANT, { query: QUERY });
    await retrieval.retrieveScored(TENANT, { query: QUERY });
    await retrieval.getPage(TENANT, { path: '/guides/canary-path-text' });
    const done = lines.filter((l) => l.event === 'retrieval.request');
    expect(done).toHaveLength(3);
    expect(done[0]?.fields).toMatchObject({
      organizationId: TENANT.organizationId,
      projectId: TENANT.projectId,
      op: 'retrieve',
      outcome: 'ok',
      ranking: 'lexical',
      hits: 2,
      lexemes: 5,
      candidates: 2,
      postings: 7,
    });
    expect(typeof done[0]?.fields['ms']).toBe('number');
    const everything = textIn(lines);
    for (const secret of ['canary-query-text', 'canary-body-text', 'canary-path-text', 'rotate']) {
      expect(everything).not.toContain(secret);
    }
    expect(observed.map((o) => o.name)).toEqual([
      'retrieval_latency_ms',
      'retrieval_latency_ms',
      'retrieval_latency_ms',
    ]);
    expect(observed[0]?.labels).toEqual({ op: 'retrieve', outcome: 'ok', size: 'under_1k' });
  });

  it('reports a project above the engine threshold with ids and the count only, and still answers', async () => {
    const { retrieval, lines } = build(answering(() => searchRow({ chunkCount: '30000' })));
    const result = await retrieval.retrieve(TENANT, { query: QUERY });
    expect(result.ok).toBe(true);
    const over = lines.filter((l) => l.event === 'retrieval.over_engine_threshold');
    expect(over).toEqual([
      {
        level: 'info',
        event: 'retrieval.over_engine_threshold',
        fields: {
          organizationId: TENANT.organizationId,
          projectId: TENANT.projectId,
          chunkCount: 30000,
          threshold: 25000,
        },
      },
    ]);
  });

  it('never reports the threshold when it is 0, or at and under it', async () => {
    for (const [count, threshold] of [
      ['30000', 0],
      ['25000', 25000],
      ['24999', 25000],
    ] as const) {
      const { retrieval, lines } = build(
        answering(() => searchRow({ chunkCount: count })),
        {
          config: { searchEngineMinChunks: threshold },
        },
      );
      await retrieval.retrieve(TENANT, { query: QUERY });
      expect(lines.filter((l) => l.event === 'retrieval.over_engine_threshold')).toEqual([]);
    }
  });

  it('buckets latency by project size', async () => {
    const sizes: string[] = [];
    for (const count of ['10', '5000', '20000', '60000']) {
      const { retrieval, observed } = build(answering(() => searchRow({ chunkCount: count })));
      await retrieval.retrieve(TENANT, { query: QUERY });
      sizes.push(observed[0]?.labels['size'] ?? '');
    }
    expect(sizes).toEqual(['under_1k', 'under_10k', 'under_25k', 'over_25k']);
  });

  it('works with no logger or metrics given', async () => {
    const scripted = scriptedReader(answering(() => searchRow()));
    const retrieval = createRetrieval({
      reader: scripted.reader,
      config: DEFAULT_RETRIEVAL_CONFIG,
      flags: on,
    });
    expect((await retrieval.retrieve(TENANT, { query: QUERY })).ok).toBe(true);
  });

  it('never puts a query in any log line, whatever the query', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 6, maxLength: 60 }), async (query) => {
        const marked = `zq${query}`;
        const { retrieval, lines } = build(answering(() => searchRow()));
        await retrieval.retrieve(TENANT, { query: marked });
        const trimmed = marked.trim().normalize('NFC');
        if (trimmed.length < 6) return;
        expect(textIn(lines)).not.toContain(JSON.stringify(trimmed).slice(1, -1));
      }),
      { numRuns: 50 },
    );
  });
});
