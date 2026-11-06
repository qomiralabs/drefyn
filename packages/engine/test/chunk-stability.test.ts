import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_LIMITS, type Dialect, type MdxIssueCode, type MdxRoot } from '@drefyn/mdx';
import { createParseClient, type ParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkNode, type Chunk } from '../src/index.ts';
import { parseClientConfig, startHost, type RunningHost } from './support/parse-host.ts';
import { chunksBySection, sectionOf } from './support/tree.ts';

const WORD = /\b[A-Za-z]{4,}\b/;
const POSITIONS = [0, 0.5, 1];
const options = { targetChars: 800, maxChars: 2000 };
const HOST_START_MS = 60_000;
const CORPUS_MS = 180_000;
// Two word edits turn a page into one the parser refuses. A sentence does not.
const EDITS_ON_THE_FIXTURE = { short: 466, long: 466, sentence: 468 };
const LONG_PAGE_CHUNKS = 20;
const MIN_LONG_PAGE_EDITS = 50;

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

const policy = {
  version: 1,
  components: new Set<string>(),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
} as const;

const BUSY: ReadonlySet<MdxIssueCode> = new Set([
  'mdx.queue_full',
  'mdx.organization_limit',
  'mdx.project_limit',
  'mdx.parse_unavailable',
  'mdx.parse_timeout',
]);

// A new tenant for each call, as the parse budget is per organization and one slow run would
// otherwise spend it. A page refused for a component this policy does not list is not a page to
// edit, but a busy host says nothing about the page, and skipping there would shrink the sample.
async function parsed(client: ParseClient, source: string, dialect: Dialect) {
  const tenant = {
    organizationId: organizationId(randomUUID()),
    projectId: projectId(randomUUID()),
  };
  const answer = await client.parse({ tenant, path: 'corpus', source, dialect, policy });
  if (answer.ok) return answer.value.ast;
  if (answer.error.some(({ code }) => BUSY.has(code))) throw new Error('the parse host is busy');
  return null;
}

type Change = (raw: string) => string;

const CHANGES = {
  short: (raw) => raw.replace(WORD, 'zebra'),
  // Greedy fill can push a block on to the next chunk, which a short word rarely shows.
  long: (raw) => raw.replace(WORD, 'zebrazebrazebrazebrazebr'),
  sentence: (raw) => `${raw} One more plain sentence ends this paragraph here.`,
} as const satisfies Readonly<Record<string, Change>>;

type ChangeName = keyof typeof CHANGES;

interface Target {
  readonly index: number;
  readonly from: number;
  readonly raw: string;
}

// The paragraph at this share of the page, found by adding up the source before it: searching
// for its text can land on an earlier copy, in another section.
function targetIn(root: MdxRoot, position: number): Target | null {
  const paragraphs = root.children.flatMap(({ type, source }, index) =>
    type === 'paragraph' && WORD.test(source?.raw ?? '') ? [index] : [],
  );
  const index = paragraphs[Math.round((paragraphs.length - 1) * position)];
  const source = index === undefined ? undefined : root.children[index]?.source;
  if (index === undefined || source === undefined) return null;
  const before = root.children.slice(0, index).reduce((sum, block) => {
    const { gapBefore = '', raw = '' } = block.source ?? {};
    return sum + gapBefore.length + raw.length;
  }, 0);
  return { index, from: before + source.gapBefore.length, raw: source.raw };
}

interface Edit {
  readonly chunks: number;
  readonly changed: number;
  readonly outside: number;
}

// Counted as a multiset, so a body that repeats on the page cannot hide a new copy of itself.
function newBodies(before: readonly string[], after: readonly string[]): number {
  const left = new Map<string, number>();
  for (const body of before) left.set(body, (left.get(body) ?? 0) + 1);
  let found = 0;
  for (const body of after) {
    const count = left.get(body) ?? 0;
    if (count === 0) found += 1;
    else left.set(body, count - 1);
  }
  return found;
}

const bodiesOf = (chunks: readonly Chunk[]) => chunks.map(({ body }) => body);

function outsideSection(before: MdxRoot, after: MdxRoot, home: number): number {
  const was = chunksBySection(before, chunkNode(before, options));
  const now = chunksBySection(after, chunkNode(after, options));
  const keys = new Set([...was.keys(), ...now.keys()]);
  keys.delete(home);
  return [...keys].filter((key) => !isDeepStrictEqual(was.get(key) ?? [], now.get(key) ?? []))
    .length;
}

async function editsOnCorpus(client: ParseClient): Promise<Record<ChangeName, readonly Edit[]>> {
  const edits: Record<ChangeName, Edit[]> = { short: [], long: [], sentence: [] };
  for (const file of readdirSync(corpus).sort()) {
    const dialect: Dialect = file.endsWith('.mdx.txt') ? 'mdx' : 'md';
    const text = readFileSync(join(corpus, file), 'utf8');
    const root = await parsed(client, text, dialect);
    if (root === null) continue;
    const before = bodiesOf(chunkNode(root, options));
    for (const position of POSITIONS) {
      const target = targetIn(root, position);
      if (target === null) continue;
      const { index, from, raw } = target;
      if (!text.startsWith(raw, from))
        throw new Error(`${file}: the block is not where it adds up`);
      for (const name of Object.keys(CHANGES) as ChangeName[]) {
        const next = text.slice(0, from) + CHANGES[name](raw) + text.slice(from + raw.length);
        const after = await parsed(client, next, dialect);
        if (after === null) continue;
        const bodies = bodiesOf(chunkNode(after, options));
        edits[name].push({
          chunks: bodies.length,
          changed: newBodies(before, bodies),
          outside: outsideSection(root, after, sectionOf(root, index)),
        });
      }
    }
  }
  return edits;
}

const changedCounts = (edits: readonly Edit[]) => edits.map(({ changed }) => changed);
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const p99 = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1] ?? Infinity;
const unchanged = (edits: readonly Edit[]) =>
  1 -
  edits.reduce((sum, { changed }) => sum + changed, 0) /
    edits.reduce((sum, { chunks }) => sum + chunks, 0);

describe('an edit on the corpus', () => {
  let running: RunningHost;
  let edits: Record<ChangeName, readonly Edit[]>;

  beforeAll(async () => {
    running = await startHost();
    edits = await editsOnCorpus(createParseClient(parseClientConfig(running.url)));
  }, HOST_START_MS + CORPUS_MS);

  afterAll(() => {
    running.host.kill('SIGKILL');
  });

  it.each(['short', 'long', 'sentence'] as const)('reaches every position: %s', (name) => {
    expect(edits[name]).toHaveLength(EDITS_ON_THE_FIXTURE[name]);
  });

  it.each(['short', 'long', 'sentence'] as const)(
    'changes nothing outside its heading section: %s',
    (name) => {
      expect(edits[name].filter(({ outside }) => outside > 0)).toEqual([]);
    },
  );

  it.each(['short', 'long'] as const)('re-embeds about one chunk per one word edit: %s', (name) => {
    const counts = changedCounts(edits[name]);
    expect(mean(counts)).toBeLessThan(1.1);
    expect(p99(counts)).toBeLessThanOrEqual(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
  });

  it('re-embeds under 1.3 chunks when a sentence is added', () => {
    expect(mean(changedCounts(edits.sentence))).toBeLessThan(1.3);
  });

  // Fails rather than skips when the fixture stops holding enough long pages.
  it.each(['short', 'long'] as const)(
    'leaves at least 95 percent unchanged on pages of 20 chunks or more: %s',
    (name) => {
      const long = edits[name].filter(({ chunks }) => chunks >= LONG_PAGE_CHUNKS);
      expect(long.length).toBeGreaterThan(MIN_LONG_PAGE_EDITS);
      expect(unchanged(long)).toBeGreaterThanOrEqual(0.95);
    },
  );
});
