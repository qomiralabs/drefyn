import { randomUUID } from 'node:crypto';
import { organizationId, projectId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { createParseClient } from '../src/client.ts';
import { runJob } from '../src/jobs.ts';
import { mergePage } from '../src/merge-job.ts';
import type { MdxRoot, ReaderPage } from '../src/index.ts';
import { CLIENT, isolatedPolicy, parsed } from './helpers.ts';

const policy = isolatedPolicy(['Note']);
const SOURCE = '# Guide\n\nShown <span hidden>words</span> and <!-- secret -->.\n';
const UNITS = [
  { heading: { depth: 1, text: 'Guide' }, text: 'Guide' },
  { text: 'Shown words and .' },
];

const readerOf = (result: ReturnType<typeof runJob>): ReaderPage | undefined =>
  result.ok && 'reader' in result.value ? result.value.reader : undefined;

describe('a job that asks for reader text', () => {
  it('gets it beside the printed tree, from the tree the reparse made', () => {
    const tree = JSON.stringify(parsed(SOURCE, 'md'));
    expect(readerOf(runJob({ tree, policy, reader: true }))).toEqual({ state: 'ok', units: UNITS });
  });

  it('gets it beside a parse', () => {
    expect(readerOf(runJob({ source: SOURCE, dialect: 'md', policy, reader: true }))).toEqual({
      state: 'ok',
      units: UNITS,
    });
  });

  it('costs nothing when not asked for', () => {
    const tree = JSON.stringify(parsed(SOURCE, 'md'));
    const printed = runJob({ tree, policy });
    const parsedJob = runJob({ source: SOURCE, dialect: 'md', policy });
    expect(printed.ok && 'reader' in printed.value).toBe(false);
    expect(parsedJob.ok && 'reader' in parsedJob.value).toBe(false);
  });

  it('says not renderable for a page the render refuses, and the print still stands', () => {
    const source = `${'Ref[^a]. '.repeat(2_001)}\n\n[^a]: n\n`;
    const result = runJob({ tree: JSON.stringify(parsed(source, 'md')), policy, reader: true });
    expect(result.ok).toBe(true);
    expect(readerOf(result)).toEqual({ state: 'not_renderable' });
  });

  it('has no reader text when the print is refused', () => {
    expect(runJob({ tree: '{', policy, reader: true })).toMatchObject({ ok: false });
  });

  it('hands a merge to the merge and adds no reader text', () => {
    const base = parsed('# Guide\n\nOne.\n', 'md');
    const ours = parsed('# Guide\n\nOne, ours.\n', 'md');
    const job = { trees: JSON.stringify({ base, ours, theirs: base }), policy, maxBlocks: 100 };
    const result = runJob(job);
    expect(result).toEqual(mergePage(job));
    expect(result).toMatchObject({ ok: true, value: { outcome: { kind: 'clean' } } });
    expect(readerOf(result)).toBeUndefined();
  });
});

describe('the client asking for reader text', () => {
  const tenant = {
    organizationId: organizationId(randomUUID()),
    projectId: projectId(randomUUID()),
  };
  const ast: MdxRoot = {
    type: 'root',
    astVersion: 1,
    dialect: 'md',
    eol: 'lf',
    children: [],
    tail: 'a',
    tailOf: '',
  };
  const answering = (value: Record<string, unknown>) => {
    const sent: unknown[] = [];
    const fetch = (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string));
      const body = JSON.stringify({ ok: true, value: { text: 'a', ast, issues: [], ...value } });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    return { sent, client: createParseClient({ ...CLIENT, url: 'http://parse.internal', fetch }) };
  };
  const print = (value: Record<string, unknown>, reader = true) => {
    const { client, sent } = answering(value);
    return { sent, result: client.print({ tenant, path: 'p', root: ast, policy, reader }) };
  };

  it('says so on the wire, on both routes', async () => {
    const { client, sent } = answering({ reader: { state: 'not_renderable' } });
    await client.print({ tenant, path: 'p', root: ast, policy, reader: true });
    await client.parse({ tenant, path: 'p', source: 'a', dialect: 'md', policy, reader: true });
    await client.print({ tenant, path: 'p', root: ast, policy });
    expect(sent.map((frame) => (frame as { reader?: unknown }).reader)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('takes a well formed answer', async () => {
    const reader = { state: 'ok', units: UNITS };
    await expect(print({ reader }).result).resolves.toMatchObject({ ok: true, value: { reader } });
  });

  it.each([
    ['no reader text', {}],
    ['an unknown state', { reader: { state: 'maybe' } }],
    ['units on a refused page', { reader: { state: 'not_renderable', units: [] } }],
    ['a unit that is not text', { reader: { state: 'ok', units: [{ text: 1 }] } }],
    ['an extra key in a unit', { reader: { state: 'ok', units: [{ text: 'a', html: '<b>' }] } }],
    [
      'a heading past depth six',
      { reader: { state: 'ok', units: [{ heading: { depth: 7, text: 'a' }, text: 'a' }] } },
    ],
    [
      'more text than the page could hold',
      { reader: { state: 'ok', units: [{ text: 'a'.repeat(2 * 1_048_576 + 65_537) }] } },
    ],
  ])('refuses an answer with %s', async (_, value) => {
    await expect(print(value).result).resolves.toMatchObject({
      error: [{ code: 'mdx.parse_failed' }],
    });
  });

  it('drops reader text it did not ask for, so a caller never stores what it did not check', async () => {
    const result = await print({ reader: { state: 'ok', units: [{ text: 'x' }] } }, false).result;
    expect(result.ok && 'reader' in result.value).toBe(false);
  });
});
