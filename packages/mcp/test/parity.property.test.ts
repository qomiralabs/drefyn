import {
  createRetrieval,
  DEFAULT_RETRIEVAL_CONFIG,
  type PageResult,
  type RetrievalErrorCode,
  type RetrievalResult,
  type RetrieveResult,
  type VersionList,
} from '@drefyn/retrieval';
import { idOf } from '@drefyn/tenancy';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT, connect, fakeRetrieval, type FakeAnswers } from './support/fake.ts';

const CODES: readonly RetrievalErrorCode[] = [
  'retrieval.bad_input',
  'retrieval.version_not_found',
  'retrieval.not_found',
  'retrieval.busy',
  'retrieval.unavailable',
];

const iso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());
const pin = fc.record({ version: fc.constantFrom('latest', 'v2'), publishedAt: iso });
const heading = fc.array(fc.string({ maxLength: 12 }), { maxLength: 3 });

const hit = fc.record({
  chunkId: fc.uuid(),
  nodeId: fc.uuid().map((id) => idOf('nod', id)),
  versionId: fc.uuid().map((id) => idOf('ver', id)),
  path: fc.string({ maxLength: 20 }).map((p) => `/${p}`),
  title: fc.string({ maxLength: 20 }),
  headingPath: heading,
  text: fc.string({ maxLength: 60 }),
  rank: fc.integer({ min: 1, max: 20 }),
});

const searchValue: fc.Arbitrary<RetrieveResult> = fc.record({
  pin,
  ranking: fc.constantFrom('lexical' as const, 'hybrid' as const),
  hits: fc.array(hit, { maxLength: 4 }),
});

const pageValue: fc.Arbitrary<PageResult> = fc.record({
  pin,
  nodeId: fc.uuid().map((id) => idOf('nod', id)),
  versionId: fc.uuid().map((id) => idOf('ver', id)),
  path: fc.string({ maxLength: 20 }).map((p) => `/${p}`),
  title: fc.string({ maxLength: 20 }),
  sections: fc.array(fc.record({ headingPath: heading, text: fc.string({ maxLength: 40 }) }), {
    maxLength: 4,
  }),
});

const versionsValue: fc.Arbitrary<VersionList> = fc.record({
  versions: fc.array(
    fc.record({
      label: fc.string({ minLength: 1, maxLength: 10 }),
      isDefault: fc.boolean(),
      deprecated: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
});

const outcome = <T>(value: fc.Arbitrary<T>): fc.Arbitrary<RetrievalResult<T>> =>
  fc.oneof(
    value.map((v) => ({ ok: true as const, value: v })),
    fc.constantFrom(...CODES).map((error) => ({ ok: false as const, error })),
  );

const word = fc.stringMatching(/^[a-z][a-z0-9 ]{0,30}$/);
const uuid = fc.uuid();

// Inputs the library accepts, so the adapter must hand them over untouched.
const validSearch = fc.record(
  {
    query: word,
    version: fc.constantFrom('latest', 'v2'),
    limit: fc.integer({ min: 1, max: 20 }),
    pathPrefix: fc.stringMatching(/^\/[a-z/]{0,20}$/),
  },
  { requiredKeys: ['query'] },
);
const validPage = fc.oneof(
  fc.record(
    { path: fc.stringMatching(/^\/[a-z/]{0,20}$/), version: fc.constant('latest') },
    {
      requiredKeys: ['path'],
    },
  ),
  fc.record({ nodeId: uuid, version: fc.constant('latest') }, { requiredKeys: ['nodeId'] }),
);

// JSON values of every shape, valid or not, for the validation half.
const loose = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  fc.constantFrom('', ' ', '  \t', 'x'.repeat(512), 'x'.repeat(513), ` ${'y'.repeat(512)} `),
  fc.constantFrom('/', '/guides', 'guides', `/${'p'.repeat(255)}`, `/${'p'.repeat(256)}`),
  fc.integer({ min: -3, max: 30 }),
  fc.double({ min: -3, max: 30, noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  uuid,
  uuid.map((id) => id.toUpperCase()),
  fc.constantFrom('latest', 'v2', 'v'.repeat(100), 'v'.repeat(101)),
);
const anySearch = fc.record(
  { query: loose, version: loose, limit: loose, pathPrefix: loose, extra: loose },
  { requiredKeys: [] },
);
const anyPage = fc.record(
  { path: loose, nodeId: loose, version: loose, extra: loose },
  { requiredKeys: [] },
);

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

const expected = <T>(result: RetrievalResult<T>) => {
  const body = result.ok ? result.value : { code: result.error };
  return {
    ...(result.ok ? {} : { isError: true }),
    structuredContent: body,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
};

describe('every tool result equals the library result for the same input', () => {
  const answers: FakeAnswers = {};
  const fake = fakeRetrieval(answers);
  let opened: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    opened = await connect(fake.retrieval);
  });
  afterAll(async () => {
    await opened.close();
  });

  const run = async (name: string, args: Record<string, unknown>) =>
    (await opened.client.callTool({ name, arguments: args })) as ToolResult;

  it('search_docs', async () => {
    await fc.assert(
      fc.asyncProperty(validSearch, outcome(searchValue), async (input, result) => {
        answers.retrieve = () => Promise.resolve(result);
        fake.calls.length = 0;
        const got = await run('search_docs', input);
        expect(got.structuredContent).toEqual(expected(result).structuredContent);
        expect(got.content).toEqual(expected(result).content);
        expect(got.isError ?? false).toBe(!result.ok);
        expect(fake.calls).toEqual([{ op: 'retrieve', tenant: TENANT, input }]);
      }),
      { numRuns: 150 },
    );
  });

  it('get_page', async () => {
    await fc.assert(
      fc.asyncProperty(validPage, outcome(pageValue), async (input, result) => {
        answers.getPage = () => Promise.resolve(result);
        fake.calls.length = 0;
        const got = await run('get_page', input);
        expect(got.structuredContent).toEqual(expected(result).structuredContent);
        expect(got.content).toEqual(expected(result).content);
        expect(got.isError ?? false).toBe(!result.ok);
        expect(fake.calls).toEqual([{ op: 'getPage', tenant: TENANT, input }]);
      }),
      { numRuns: 150 },
    );
  });

  it('list_versions', async () => {
    await fc.assert(
      fc.asyncProperty(outcome(versionsValue), async (result) => {
        answers.listVersions = () => Promise.resolve(result);
        const got = await run('list_versions', {});
        expect(got.structuredContent).toEqual(expected(result).structuredContent);
        expect(got.content).toEqual(expected(result).content);
        expect(got.isError ?? false).toBe(!result.ok);
      }),
      { numRuns: 100 },
    );
  });
});

// The real library over a database that is down: whatever it accepts reaches the read and
// answers unavailable, and whatever it refuses answers its own code. The adapter must answer
// the same code for every input, so its schema can never be stricter or looser than the
// library's.
describe('the adapter refuses exactly what the library refuses', () => {
  const library = createRetrieval({
    reader: { read: () => Promise.reject(new Error('down')) },
    config: DEFAULT_RETRIEVAL_CONFIG,
    flags: { evaluate: () => Promise.resolve({ value: true }) },
  });
  let opened: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    opened = await connect(library);
  });
  afterAll(async () => {
    await opened.close();
  });

  const codeOf = async (name: string, args: Record<string, unknown>) => {
    const got = (await opened.client.callTool({ name, arguments: args })) as ToolResult;
    return (got.structuredContent as { code?: string } | undefined)?.code ?? 'ok';
  };

  it('search_docs', async () => {
    await fc.assert(
      fc.asyncProperty(anySearch, async (input) => {
        const direct = await library.retrieve(TENANT, input as never);
        expect(await codeOf('search_docs', input)).toBe(direct.ok ? 'ok' : direct.error);
      }),
      { numRuns: 400 },
    );
  });

  it('get_page', async () => {
    await fc.assert(
      fc.asyncProperty(anyPage, async (input) => {
        const direct = await library.getPage(TENANT, input as never);
        expect(await codeOf('get_page', input)).toBe(direct.ok ? 'ok' : direct.error);
      }),
      { numRuns: 400 },
    );
  });
});
