import type { AccessContext, ReachableProject } from '@drefyn/auth';
import type { Engine, EngineStore, NodePage } from '@drefyn/engine';
import { idOf } from '@drefyn/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPagesRead, type PagesReadDeps } from '../src/server/pages-read.ts';

const ORG = idOf('org', '01900000-0000-7000-8000-00000000a001');
const OTHER_ORG = idOf('org', '01900000-0000-7000-8000-00000000b001');
const PROJECT = idOf('prj', '01900000-0000-7000-8000-00000000a101');
const OTHER_PROJECT = idOf('prj', '01900000-0000-7000-8000-00000000a102');
const TYPE = '01900000-0000-7000-8000-00000000a201';

const access = { organizationId: ORG, permissions: ['docs.read'] } as unknown as AccessContext;
const project: ReachableProject = {
  projectId: PROJECT,
  name: 'Payments API docs',
  product: 'docs',
  slug: 'payments-api',
  readOnly: false,
};

const page = (over: Partial<NodePage['items'][number]> = {}): NodePage['items'][number] => ({
  nodeId: idOf('nod', '01900000-0000-7000-8000-00000000a301'),
  family: 'docs_page',
  typeId: TYPE,
  lifecycle: 'draft',
  slug: 'getting-started',
  versionId: null,
  updatedAt: new Date('2026-11-12T09:30:00.000Z'),
  ...over,
});

// The type lookup's query, step by step, so the test can read what it was scoped to.
interface Step {
  readonly name: string;
  readonly args: readonly unknown[];
}

function scriptedStore(found: { id: string } | undefined) {
  const steps: Step[] = [];
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'select', 'where']) {
    chain[name] = (...args: unknown[]) => {
      steps.push({ name, args });
      return chain;
    };
  }
  chain['executeTakeFirst'] = () => Promise.resolve(found);
  const tenant = vi.fn((_tenant: unknown, work: (tx: unknown) => Promise<unknown>) => work(chain));
  return { store: { gate: {}, tenant } as unknown as EngineStore, tenant, steps };
}

let queryNodes: ReturnType<typeof vi.fn<Engine['queryNodes']>>;
let findProject: ReturnType<typeof vi.fn<PagesReadDeps['findProject']>>;
let data: ReturnType<typeof vi.fn<PagesReadDeps['data']>>;
let scripted: ReturnType<typeof scriptedStore>;

const read = (input: unknown, slug = 'payments-api') =>
  createPagesRead({ data, findProject })(access, slug, input);

beforeEach(() => {
  scripted = scriptedStore({ id: TYPE });
  queryNodes = vi.fn<Engine['queryNodes']>(() =>
    Promise.resolve({ ok: true, value: { items: [page()], nextCursor: null, backfilling: [] } }),
  );
  findProject = vi.fn<PagesReadDeps['findProject']>((_access, product, slug) =>
    Promise.resolve(product === 'docs' && slug === 'payments-api' ? project : undefined),
  );
  data = vi.fn<PagesReadDeps['data']>(() =>
    Promise.resolve({ store: scripted.store, engine: { queryNodes } as unknown as Engine }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const refusal = (code: string, issues: { path: string; code: string }[] = []) =>
  Promise.resolve({
    ok: false as const,
    error: { code: code as 'engine.unavailable', retryable: true, issues },
  });

describe('the Pages read', () => {
  it('lists the pages of the session organization and the reachable project', async () => {
    expect(await read({})).toEqual({
      ok: true,
      pages: [
        {
          id: '01900000-0000-7000-8000-00000000a301',
          slug: 'getting-started',
          lifecycle: 'draft',
          editedAt: '2026-11-12T09:30:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(findProject).toHaveBeenCalledWith(access, 'docs', 'payments-api');
    expect(queryNodes).toHaveBeenCalledWith(
      { organizationId: ORG, projectId: PROJECT },
      { typeId: TYPE, limit: 50 },
    );
  });

  it('finds the page type inside the tenant, by organization, project, family and key', async () => {
    await read({});
    expect(scripted.tenant.mock.calls[0]?.[0]).toEqual({ organizationId: ORG, projectId: PROJECT });
    expect(scripted.steps).toEqual([
      { name: 'selectFrom', args: ['content_types'] },
      { name: 'select', args: ['id'] },
      { name: 'where', args: ['organization_id', '=', ORG] },
      { name: 'where', args: ['project_id', '=', PROJECT] },
      { name: 'where', args: ['family', '=', 'docs_page'] },
      { name: 'where', args: ['key', '=', 'page'] },
    ]);
  });

  it('passes the page cursor on and hands the next one back', async () => {
    queryNodes.mockResolvedValueOnce({
      ok: true,
      value: { items: [], nextCursor: 'next-one', backfilling: [] },
    });
    expect(await read({ cursor: 'this-one' })).toMatchObject({ ok: true, nextCursor: 'next-one' });
    expect(queryNodes.mock.calls[0]?.[1]).toEqual({ typeId: TYPE, limit: 50, cursor: 'this-one' });
  });

  it.each([
    ['an organization id', { organizationId: OTHER_ORG }],
    ['a project id', { projectId: OTHER_PROJECT }],
    ['both beside a cursor', { cursor: 'c', organizationId: OTHER_ORG, projectId: OTHER_PROJECT }],
    ['any other field', { limit: 500 }],
    ['a cursor that is not text', { cursor: 7 }],
    ['an empty cursor', { cursor: '' }],
    ['an oversized cursor', { cursor: 'c'.repeat(1025) }],
    ['no object at all', 'cursor'],
  ])('refuses a body carrying %s, before any lookup', async (_name, input) => {
    expect(await read(input)).toEqual({ ok: false, code: 'pages.invalid' });
    expect(findProject).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
    expect(queryNodes).not.toHaveBeenCalled();
  });

  it('answers not found for a project out of reach, with no engine call', async () => {
    expect(await read({}, 'someone-elses')).toEqual({ ok: false, code: 'pages.not_found' });
    expect(data).not.toHaveBeenCalled();
    expect(queryNodes).not.toHaveBeenCalled();
  });

  it('lists nothing for a project that has no page type yet', async () => {
    scripted = scriptedStore(undefined);
    expect(await read({})).toEqual({ ok: true, pages: [], nextCursor: null });
    expect(queryNodes).not.toHaveBeenCalled();
  });

  it.each(['engine.query_busy', 'engine.write_busy', 'engine.pool_busy'])(
    'reads %s as busy',
    async (code) => {
      queryNodes.mockReturnValueOnce(refusal('engine.unavailable', [{ path: 'query', code }]));
      expect(await read({})).toEqual({ ok: false, code: 'pages.busy' });
    },
  );

  it('reads any other unavailable as unavailable', async () => {
    queryNodes.mockReturnValueOnce(refusal('engine.unavailable'));
    expect(await read({})).toEqual({ ok: false, code: 'pages.unavailable' });
  });

  it('reads a cursor the engine refuses as invalid', async () => {
    queryNodes.mockReturnValueOnce(refusal('engine.validation_failed'));
    expect(await read({ cursor: 'forged' })).toEqual({ ok: false, code: 'pages.invalid' });
  });

  it('reads an engine not found as not found', async () => {
    queryNodes.mockReturnValueOnce(refusal('engine.not_found'));
    expect(await read({})).toEqual({ ok: false, code: 'pages.not_found' });
  });

  it('reads anything else the engine refuses as unavailable', async () => {
    queryNodes.mockReturnValueOnce(refusal('engine.forbidden'));
    expect(await read({})).toEqual({ ok: false, code: 'pages.unavailable' });
  });

  it('answers unavailable when the engine cannot be built, logging ids and no message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    data.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-host'));
    expect(await read({})).toEqual({ ok: false, code: 'pages.unavailable' });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toEqual({
      level: 'warn',
      event: 'dashboard.pages_read_failed',
      service: 'dashboard',
      organizationId: ORG,
      projectId: PROJECT,
      error: 'Error',
    });
  });

  it('answers unavailable when the type lookup throws', async () => {
    scripted.tenant.mockRejectedValueOnce(new TypeError('db'));
    expect(await read({})).toEqual({ ok: false, code: 'pages.unavailable' });
  });
});
