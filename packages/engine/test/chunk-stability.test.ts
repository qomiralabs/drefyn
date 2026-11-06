import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type Dialect, type MdxRoot } from '@drefyn/mdx';
import { createParseClient, type ParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { startHost, type RunningHost } from './support/parse-host.ts';

const REPLACEMENT = 'zebra';
const WORD = /\b[A-Za-z]{4,}\b/;
const POSITIONS = [0, 0.5, 1];
const options = { targetChars: 800, maxChars: 2000 };
const HOST_START_MS = 60_000;
const CORPUS_MS = 180_000;

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

const tenant = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8101'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8102'),
};

const policy = {
  version: 1,
  components: new Set<string>(),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
} as const;

// A page the parser refuses, for a component this policy does not list, is not a page to edit.
async function parsed(client: ParseClient, source: string, dialect: Dialect) {
  const answer = await client.parse({ tenant, path: 'corpus', source, dialect, policy });
  return answer.ok ? answer.value.ast : null;
}

// One word of the block at this share of the page's paragraphs, in place in the file.
function edited(text: string, root: MdxRoot, position: number): string | null {
  const paragraphs = root.children.filter(
    ({ type, source }) => type === 'paragraph' && WORD.test(source?.raw ?? ''),
  );
  const target = paragraphs[Math.round((paragraphs.length - 1) * position)];
  if (target?.source === undefined) return null;
  const { raw } = target.source;
  const at = text.indexOf(raw);
  if (at < 0) return null;
  return text.slice(0, at) + raw.replace(WORD, REPLACEMENT) + text.slice(at + raw.length);
}

interface Edit {
  readonly chunks: number;
  readonly changed: number;
}

async function editsOnCorpus(client: ParseClient): Promise<readonly Edit[]> {
  const edits: Edit[] = [];
  for (const file of readdirSync(corpus).sort()) {
    const dialect: Dialect = file.endsWith('.mdx.txt') ? 'mdx' : 'md';
    const text = readFileSync(join(corpus, file), 'utf8');
    const root = await parsed(client, text, dialect);
    if (root === null) continue;
    const before = new Set(chunkNode(root, options).map(({ body }) => body));
    for (const position of POSITIONS) {
      const next = edited(text, root, position);
      const after = next === null ? null : await parsed(client, next, dialect);
      if (after === null) continue;
      const bodies = chunkNode(after, options).map(({ body }) => body);
      edits.push({
        chunks: bodies.length,
        changed: bodies.filter((body) => !before.has(body)).length,
      });
    }
  }
  return edits;
}

const share = (edits: readonly Edit[]) =>
  edits.reduce((sum, { changed }) => sum + changed, 0) /
  edits.reduce((sum, { chunks }) => sum + chunks, 0);

describe('a one word edit on the corpus', () => {
  let running: RunningHost;
  let edits: readonly Edit[];

  beforeAll(async () => {
    running = await startHost();
    edits = await editsOnCorpus(createParseClient({ url: running.url }));
  }, HOST_START_MS + CORPUS_MS);

  afterAll(() => {
    running.host.kill('SIGKILL');
  });

  it('reaches every page position', () => {
    expect(edits.length).toBeGreaterThan(400);
  });

  // Any edit changes at least the chunk holding the word, so a page under 20 chunks cannot reach
  // 95 percent whatever the chunker does. The median page here is 2 KB and about 3 chunks.
  it('leaves at least 95 percent of chunks unchanged on pages of 20 chunks or more', () => {
    const long = edits.filter(({ chunks }) => chunks >= 20);
    expect(long.length).toBeGreaterThan(50);
    expect(share(long)).toBeLessThanOrEqual(0.05);
  });

  it('touches no more than two chunks on any page', () => {
    expect(Math.max(...edits.map(({ changed }) => changed))).toBeLessThanOrEqual(2);
  });

  it('holds the whole corpus at one chunk per edit, which is about 90 percent unchanged', () => {
    expect(share(edits)).toBeLessThanOrEqual(0.1);
  });
});
