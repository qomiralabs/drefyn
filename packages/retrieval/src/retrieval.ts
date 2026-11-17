import { DbError, withPublishedReader, type PublishedDatabase } from '@drefyn/db';
import type { FlagContext } from '@drefyn/flags';
import { idOf, type IdOf, type TenantRef } from '@drefyn/tenancy';
import type { RetrievalConfig } from './config.ts';
import { LATEST, parsePageInput, parseRetrieveInput, type ParsedRetrieve } from './input.ts';
import {
  pageStatement,
  parsePageRows,
  parseSearchRow,
  prepareRead,
  searchStatement,
  type ReaderTx,
  type SearchRow,
} from './statement.ts';

export type NodeId = IdOf<'nod'>;
export type VersionId = IdOf<'ver'>;

export type RetrievalErrorCode =
  | 'retrieval.bad_input'
  | 'retrieval.version_not_found'
  | 'retrieval.not_found'
  // A statement timeout or the organization's in flight limit; retry.
  | 'retrieval.busy'
  // The database or the flag source is down.
  | 'retrieval.unavailable';

export type RetrievalResult<T, E extends string = RetrievalErrorCode> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface RetrieveInput {
  readonly query: string;
  readonly version?: string;
  readonly limit?: number;
  readonly pathPrefix?: string;
}

export interface RetrievalHit {
  readonly chunkId: string;
  readonly nodeId: NodeId;
  // The published node version the text came from.
  readonly versionId: VersionId;
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  // Reader text only, never source or HTML.
  readonly text: string;
  // 1 based. Scores stay inside, so ranking can change without breaking a client.
  readonly rank: number;
}

export interface RetrievePin {
  readonly version: string;
  // The newest publish in the set read, ISO 8601.
  readonly publishedAt: string;
}

export interface RetrieveResult {
  readonly pin: RetrievePin;
  readonly ranking: 'lexical' | 'hybrid';
  readonly hits: readonly RetrievalHit[];
}

export interface ScoredRetrieveResult extends RetrieveResult {
  // 0 to 1: the IDF weighted share of the question's lexemes the top hit holds; 0 with no hits.
  readonly coverage: number;
}

export interface PageInput {
  readonly path?: string;
  readonly nodeId?: string;
  readonly version?: string;
}

export interface PageResult {
  readonly pin: RetrievePin;
  readonly nodeId: NodeId;
  readonly versionId: VersionId;
  readonly path: string;
  readonly title: string;
  readonly sections: readonly {
    readonly headingPath: readonly string[];
    readonly text: string;
  }[];
}

export interface VersionList {
  readonly versions: readonly {
    readonly label: string;
    readonly isDefault: boolean;
    readonly deprecated: boolean;
  }[];
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Ids, codes, counts and timings only. Never the question, its lexemes, a path or chunk text:
// lexemes are fragments of both the question and the page.
export interface RetrievalLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export interface RetrievalMetrics {
  observe(
    name: 'retrieval_latency_ms',
    value: number,
    labels: Readonly<Record<string, string>>,
  ): void;
}

export interface RetrievalFlags {
  evaluate(
    name: 'retrieval.v1',
    context: FlagContext,
  ): Promise<{ readonly value: boolean; readonly errorCode?: string }>;
}

// Where reads run. publishedReader is the only real one; it holds the public reader role,
// which has no grant on any draft table.
export interface RetrievalReader {
  read<T>(tenant: TenantRef, timeoutMs: number, work: (tx: ReaderTx) => Promise<T>): Promise<T>;
}

export const publishedReader = (db: PublishedDatabase): RetrievalReader => ({
  read: (tenant, timeoutMs, work) => withPublishedReader(db, tenant, work, { timeoutMs }),
});

export interface RetrievalDeps {
  readonly reader: RetrievalReader;
  readonly config: RetrievalConfig;
  readonly flags: RetrievalFlags;
  readonly logger?: RetrievalLogger;
  readonly metrics?: RetrievalMetrics;
}

export interface Retrieval {
  retrieve(tenant: TenantRef, input: RetrieveInput): Promise<RetrievalResult<RetrieveResult>>;
  // For the reader assistant's gate only. Never exposed on a route or MCP, which keep ranks.
  retrieveScored(
    tenant: TenantRef,
    input: RetrieveInput,
  ): Promise<RetrievalResult<ScoredRetrieveResult>>;
  getPage(tenant: TenantRef, input: PageInput): Promise<RetrievalResult<PageResult>>;
  listVersions(tenant: TenantRef): Promise<RetrievalResult<VersionList>>;
}

type Op = 'retrieve' | 'retrieve_scored' | 'get_page' | 'list_versions';

interface Outcome<T> {
  readonly result: RetrievalResult<T>;
  readonly fields?: LogFields;
  readonly chunkCount?: number | null;
}

const refused = <T>(error: RetrievalErrorCode, fields?: LogFields): Outcome<T> => ({
  result: { ok: false, error },
  ...(fields === undefined ? {} : { fields }),
});

const ids = (tenant: TenantRef) => ({
  organizationId: tenant.organizationId,
  projectId: tenant.projectId,
});

// Latency by project size, so memory pressure on large projects shows before the cutoff.
const sizeOf = (chunkCount: number | null | undefined) => {
  if (chunkCount === null || chunkCount === undefined) return 'unknown';
  if (chunkCount < 1000) return 'under_1k';
  if (chunkCount < 10_000) return 'under_10k';
  if (chunkCount <= 25_000) return 'under_25k';
  return 'over_25k';
};

class ReadFailure extends Error {
  readonly code: RetrievalErrorCode;
  readonly reason: string;

  constructor(code: RetrievalErrorCode, reason: string) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}

const failureOf = (error: unknown): ReadFailure => {
  if (error instanceof ReadFailure) return error;
  if (error instanceof DbError) {
    return new ReadFailure(
      error.code === 'DB_TIMEOUT' ? 'retrieval.busy' : 'retrieval.unavailable',
      error.code,
    );
  }
  return new ReadFailure('retrieval.unavailable', 'unknown');
};

const noopLogger: RetrievalLogger = { info: () => undefined, warn: () => undefined };
const noopMetrics: RetrievalMetrics = { observe: () => undefined };

export function createRetrieval(deps: RetrievalDeps): Retrieval {
  const { reader, config, flags } = deps;
  const logger = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? noopMetrics;
  // In memory and per process; an entry lives only while its organization has a read open.
  const inFlight = new Map<string, number>();

  const flagOn = async (tenant: TenantRef): Promise<boolean | null> => {
    try {
      const { value, errorCode } = await flags.evaluate('retrieval.v1', ids(tenant));
      if (errorCode === undefined) return value;
      logger.warn('retrieval.flag_read_failed', { ...ids(tenant), code: errorCode });
    } catch {
      logger.warn('retrieval.flag_read_failed', { ...ids(tenant), code: 'FLAG_THREW' });
    }
    return null;
  };

  // The one way a read reaches Postgres: the organization's slot, the reader role, the local
  // settings, then one statement. Throws ReadFailure.
  const read = async <T>(
    tenant: TenantRef,
    statement: (tx: ReaderTx) => Promise<T>,
  ): Promise<T> => {
    const key = tenant.organizationId;
    const open = inFlight.get(key) ?? 0;
    if (open >= config.maxInFlight) throw new ReadFailure('retrieval.busy', 'in_flight');
    inFlight.set(key, open + 1);
    try {
      return await reader.read(tenant, config.timeoutMs, async (tx) => {
        await prepareRead(tx, config.timeoutMs);
        return statement(tx);
      });
    } catch (error) {
      throw failureOf(error);
    } finally {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left <= 0) inFlight.delete(key);
      else inFlight.set(key, left);
    }
  };

  // Flag, then the work, then one log line and one latency sample whatever happened. Off reads
  // as not_found, so a route maps it to 404 as if the feature did not exist; a flag that cannot
  // be read fails closed.
  const run = async <T>(
    op: Op,
    tenant: TenantRef,
    work: () => Promise<Outcome<T>>,
  ): Promise<RetrievalResult<T>> => {
    const started = performance.now();
    let outcome: Outcome<T>;
    const on = await flagOn(tenant);
    if (on === null) outcome = refused('retrieval.unavailable');
    else if (!on) outcome = refused('retrieval.not_found');
    else {
      try {
        outcome = await work();
      } catch (error) {
        const failure = failureOf(error);
        logger.warn('retrieval.read_failed', {
          ...ids(tenant),
          op,
          code: failure.code,
          reason: failure.reason,
        });
        outcome = refused(failure.code);
      }
    }
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const label = outcome.result.ok ? 'ok' : outcome.result.error;
    logger.info('retrieval.request', {
      ...ids(tenant),
      op,
      outcome: label,
      ms,
      ...outcome.fields,
    });
    metrics.observe('retrieval_latency_ms', ms, {
      op,
      outcome: label,
      size: sizeOf(outcome.chunkCount),
    });
    return outcome.result;
  };

  const search = async (
    tenant: TenantRef,
    input: RetrieveInput,
    scored: boolean,
  ): Promise<Outcome<ScoredRetrieveResult>> => {
    const parsed: ParsedRetrieve | null = parseRetrieveInput(input);
    if (parsed === null) return refused('retrieval.bad_input');
    // Named docs versions do not exist yet, so latest is the only set there is.
    if (parsed.version !== LATEST) return refused('retrieval.version_not_found');
    const row: SearchRow = await read(tenant, async (tx) => {
      const { rows } = await searchStatement(tenant, {
        label: LATEST,
        query: parsed.query,
        limit: parsed.limit,
        pathPrefix: parsed.pathPrefix,
        scored,
        caps: config,
      }).execute(tx);
      const found = parseSearchRow(rows[0]);
      if (found === null) throw new ReadFailure('retrieval.unavailable', 'row_shape');
      return found;
    });
    const counts = {
      lexemes: row.lexemes,
      candidates: row.candidates,
      postings: row.postings,
    };
    if (
      config.searchEngineMinChunks > 0 &&
      row.chunkCount !== null &&
      row.chunkCount > config.searchEngineMinChunks
    ) {
      logger.info('retrieval.over_engine_threshold', {
        ...ids(tenant),
        chunkCount: row.chunkCount,
        threshold: config.searchEngineMinChunks,
      });
    }
    // No current published version is visible: the project has no latest yet.
    if (row.publishedAt === null) {
      return { ...refused('retrieval.version_not_found', counts), chunkCount: row.chunkCount };
    }
    const hits = row.hits.map((hit, at): RetrievalHit => ({
      chunkId: hit.chunkId,
      nodeId: idOf('nod', hit.nodeId),
      versionId: idOf('ver', hit.versionId),
      path: hit.path,
      title: hit.title,
      headingPath: hit.headingPath,
      text: hit.text,
      rank: at + 1,
    }));
    return {
      result: {
        ok: true,
        value: {
          pin: { version: LATEST, publishedAt: row.publishedAt },
          // Vectors join by rank fusion once embeddings are published and HNSW under RLS is
          // proven; until then every answer is lexical.
          ranking: 'lexical',
          hits,
          coverage: row.coverage ?? 0,
        },
      },
      fields: { ...counts, hits: hits.length, ranking: 'lexical' },
      chunkCount: row.chunkCount,
    };
  };

  return {
    retrieve: (tenant, input) =>
      run('retrieve', tenant, async () => {
        const outcome = await search(tenant, input, false);
        if (!outcome.result.ok) return outcome;
        const { pin, ranking, hits } = outcome.result.value;
        return { ...outcome, result: { ok: true, value: { pin, ranking, hits } } };
      }),

    retrieveScored: (tenant, input) =>
      run('retrieve_scored', tenant, () => search(tenant, input, true)),

    getPage: (tenant, input) =>
      run('get_page', tenant, async (): Promise<Outcome<PageResult>> => {
        const parsed = parsePageInput(input);
        if (parsed === null) return refused('retrieval.bad_input');
        if (parsed.version !== LATEST) return refused('retrieval.version_not_found');
        const rows = await read(tenant, async (tx) => {
          const { rows: raw } = await pageStatement(tenant, parsed.by).execute(tx);
          const found = parsePageRows(raw);
          if (found === null) throw new ReadFailure('retrieval.unavailable', 'row_shape');
          return found;
        });
        const first = rows[0];
        if (first === undefined) return refused('retrieval.not_found');
        // Every row is one version of one page, so they share a publish time.
        const newest = first.publishedAt;
        return {
          result: {
            ok: true,
            value: {
              pin: { version: LATEST, publishedAt: newest },
              nodeId: idOf('nod', first.nodeId),
              versionId: idOf('ver', first.versionId),
              path: first.path,
              title: first.title,
              sections: rows.map((row) => ({ headingPath: row.headingPath, text: row.text })),
            },
          },
          fields: { sections: rows.length },
        };
      }),

    listVersions: (tenant) =>
      run('list_versions', tenant, () =>
        Promise.resolve({
          result: {
            ok: true,
            value: { versions: [{ label: LATEST, isDefault: true, deprecated: false }] },
          },
        }),
      ),
  };
}
