import { withTenant, type Database } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { B, K1 } from '../../src/bm25.ts';
import type { RetrievalConfig } from '../../src/index.ts';

// BM25 written out in TypeScript, from postings recomputed from the published text, never from
// the term tables. The statement must agree with this for every corpus, query and cap.

export const idf = (chunkCount: number, df: number): number =>
  Math.log(1 + (chunkCount - df + 0.5) / (df + 0.5));

export const weight = (tf: number, length: number, avgLength: number, termIdf: number): number =>
  (termIdf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * length) / avgLength));

export interface Posting {
  readonly chunkId: string;
  readonly tf: number;
  readonly length: number;
}

export interface Corpus {
  readonly chunkCount: number;
  readonly totalLength: number;
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
}

export type Caps = Pick<
  RetrievalConfig,
  'maxQueryTerms' | 'commonTermPercent' | 'maxPostings' | 'maxScoredCandidates'
>;

export interface ReferenceHit {
  readonly chunkId: string;
  readonly score: number;
}

export interface ReferenceResult {
  readonly hits: readonly ReferenceHit[];
  readonly coverage: number;
  readonly lexemes: number;
  readonly candidates: number;
  readonly postingsRead: number;
  readonly picked: readonly string[];
}

// The statement orders by the score rounded to 9 places, so float noise in a sum cannot
// reorder two chunks with the same text.
export const rounded = (score: number) => Math.round(score * 1e9) / 1e9;

const byScore = (a: ReferenceHit, b: ReferenceHit) =>
  rounded(b.score) - rounded(a.score) || (a.chunkId < b.chunkId ? -1 : 1);

export function reference(
  corpus: Corpus,
  queryLexemes: readonly string[],
  caps: Caps,
  limit: number,
): ReferenceResult {
  const empty = { hits: [], coverage: 0, candidates: 0, postingsRead: 0, picked: [] };
  if (corpus.chunkCount === 0) return { ...empty, lexemes: 0 };
  const n = corpus.chunkCount;
  const avg = Math.max(corpus.totalLength, 1) / n;
  const q = queryLexemes.slice(0, caps.maxQueryTerms).map((lexeme) => {
    const df = corpus.postings.get(lexeme)?.length ?? 0;
    return { lexeme, df, idf: idf(n, df) };
  });
  const rarest = (a: { df: number; lexeme: string }, b: { df: number; lexeme: string }) =>
    a.df - b.df || (a.lexeme < b.lexeme ? -1 : 1);
  const eligible = q
    .filter((l) => l.df > 0 && l.df * 100 <= caps.commonTermPercent * n)
    .sort(rarest);
  let cum = 0;
  const picks = eligible.filter((l, at) => {
    cum += l.df;
    return cum <= caps.maxPostings || at === 0;
  });
  if (eligible.length === 0) {
    const fallback = q.filter((l) => l.df > 0).sort(rarest)[0];
    if (fallback !== undefined) picks.push(fallback);
  }
  const reads = picks.flatMap((pick) =>
    [...(corpus.postings.get(pick.lexeme) ?? [])]
      .sort((a, b) => b.tf - a.tf || (a.chunkId < b.chunkId ? -1 : 1))
      .slice(0, Math.min(pick.df, caps.maxPostings))
      .map((posting) => ({ ...posting, lexeme: pick.lexeme, idf: pick.idf })),
  );
  const partial = new Map<string, number>();
  for (const read of reads) {
    partial.set(
      read.chunkId,
      (partial.get(read.chunkId) ?? 0) + weight(read.tf, read.length, avg, read.idf),
    );
  }
  const candidates = [...partial]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort(byScore)
    .slice(0, caps.maxScoredCandidates);
  // Every candidate gets every question lexeme's term, read or probed.
  const termOf = (lexeme: string, chunkId: string) =>
    corpus.postings.get(lexeme)?.find((p) => p.chunkId === chunkId);
  const scored = candidates.map(({ chunkId }) => ({
    chunkId,
    score: q.reduce((sum, l) => {
      const posting = termOf(l.lexeme, chunkId);
      return posting === undefined ? sum : sum + weight(posting.tf, posting.length, avg, l.idf);
    }, 0),
  }));
  const hits = scored.sort(byScore).slice(0, limit);
  const top = hits[0];
  const total = q.reduce((sum, l) => sum + l.idf, 0);
  const covered =
    top === undefined
      ? 0
      : q.reduce((sum, l) => (termOf(l.lexeme, top.chunkId) === undefined ? sum : sum + l.idf), 0);
  return {
    hits,
    coverage: total === 0 ? 0 : covered / total,
    lexemes: q.length,
    candidates: candidates.length,
    postingsRead: reads.length,
    picked: picks.map((p) => p.lexeme),
  };
}

// The public current chunks' postings, from their stored tsvectors, read as the app role.
export async function recomputedCorpus(app: Database, tenant: TenantRef): Promise<Corpus> {
  return withTenant(app, tenant, async (tx) => {
    const { rows } = await sql<{ id: string; lexeme: string; tf: number; length: number }>`
      select c.id::text as id, u.lexeme, coalesce(cardinality(u.positions), 1)::int as tf,
             (select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)
                from unnest(c.search) p)::int as length
        from app.published_chunks c cross join lateral unnest(c.search) u
       where c.is_current and c.visibility = 'public'`.execute(tx);
    const { rows: counted } = await sql<{ n: number; total: number }>`
      select count(*)::int as n,
             coalesce(sum((select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)
                             from unnest(c.search) p)), 0)::int as total
        from app.published_chunks c
       where c.is_current and c.visibility = 'public'`.execute(tx);
    const postings = new Map<string, Posting[]>();
    for (const row of rows) {
      const list = postings.get(row.lexeme) ?? [];
      list.push({ chunkId: row.id, tf: row.tf, length: row.length });
      postings.set(row.lexeme, list);
    }
    return {
      chunkCount: counted[0]?.n ?? 0,
      totalLength: counted[0]?.total ?? 0,
      postings,
    };
  });
}

// The question's lexemes in the order the statement keeps them: first position, then text.
export async function queryLexemes(app: Database, tenant: TenantRef, query: string) {
  return withTenant(app, tenant, async (tx) => {
    const { rows } = await sql<{ lexeme: string }>`
      select u.lexeme from unnest(to_tsvector('simple'::regconfig, ${query}::text)) u
       order by coalesce(u.positions[1], 0), u.lexeme`.execute(tx);
    return rows.map((row) => row.lexeme);
  });
}
