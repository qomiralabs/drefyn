import { DbError } from '@drefyn/db';
import { createTestFlagClient } from '@drefyn/flags/testing';
import type { MdxIssueCode, MdxRoot, PrintResult } from '@drefyn/mdx';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  chunkNode,
  createEngine,
  DEFAULT_ENGINE_CONFIG,
  noopTracer,
  type EngineDeps,
  type EngineLogger,
  type EngineTracer,
  type LogFields,
  type SaveDraftInput,
} from '../src/index.ts';
import { scriptedStore, type Responder, type Statement } from './support/scripted-store.ts';
import { treeOf } from './support/tree.ts';

const pinFile = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'ast', 'v1.json');
const pins = JSON.parse(readFileSync(pinFile, 'utf8')) as Readonly<Record<string, MdxRoot>>;
const page = Object.values(pins).find((root) => root.children.length > 1);
if (page === undefined) throw new Error('no pinned trees');

const DEFAULT_CHUNKS = { targetChars: 800, maxChars: 2000 };

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const NODE = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8003');
const VERSION = '01890a5d-ac96-774b-bcce-b302099a8004';
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8005';
const SHA = Buffer.alloc(32, 7);

const save = (over: Partial<SaveDraftInput> = {}): SaveDraftInput => ({
  tenant,
  nodeId: NODE,
  expectedHeadVersionId: null,
  content: page,
  origin: 'human',
  actor: { kind: 'system', job: 'test' },
  idempotencyKey: 'key-1',
  ...over,
});

const joined = (root: MdxRoot) =>
  root.children.reduce(
    (text, { source }) => text + (source?.gapBefore ?? '') + (source?.raw ?? ''),
    '',
  ) + root.tail;

const printed = (ast: MdxRoot): PrintResult => ({
  ok: true,
  value: { ast, text: joined(ast), issues: [] },
});

const parseOk = { print: () => Promise.resolve(printed(page)) };

const has = (statement: Statement, text: string) => statement.sql.includes(text);

const PLAN = { plan_tier: 'self_hosted', organization_read_only: null, project_read_only: null };
const NODE_ROW = { id: NODE, family: 'docs_page', type_id: TYPE, head_version_id: null };

const happy: Responder = (statement) => {
  if (has(statement, 'for update')) return [NODE_ROW];
  if (has(statement, 'from "organizations"')) return [{ ...PLAN, nodes: 1 }];
  if (has(statement, 'insert into "node_versions"')) {
    return [{ id: VERSION, seq: 1, content_sha256: SHA }];
  }
  if (has(statement, 'from "content_types"')) {
    return [{ current_schema_version: 1, family: 'docs_page' }];
  }
  if (has(statement, 'insert into "nodes"')) return [{ id: NODE }];
  if (has(statement, 'insert into "organization_node_counts"')) return [{ nodes: 1 }];
  if (has(statement, 'update "nodes"')) return [{}];
  return [];
};

const build = (respond: Responder, over: Partial<EngineDeps> = {}) => {
  const scripted = scriptedStore(respond);
  const engine = createEngine({
    store: scripted.store,
    parse: parseOk,
    parsePolicy: {
      version: 1,
      components: [],
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https'],
    },
    flags: { evaluate: () => Promise.resolve({ value: true }) },
    ...over,
  });
  return { engine, ...scripted };
};

describe('input', () => {
  it('names each bad field and reaches no statement', async () => {
    const { engine, statements } = build(happy);
    const done = await engine.saveDraft({
      ...save(),
      nodeId: 'nope',
      origin: 'webhook',
      idempotencyKey: '',
    } as never);
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    if (!done.ok) {
      expect(done.error.issues.map((issue) => issue.path).sort()).toEqual([
        'idempotencyKey',
        'nodeId',
        'origin',
      ]);
    }
    expect(statements).toEqual([]);
  });

  it('never quotes a refused value', async () => {
    const { engine } = build(happy);
    const done = await engine.saveDraft({ ...save(), origin: 'CANARY' } as never);
    expect(JSON.stringify(done)).not.toContain('CANARY');
  });

  it.each([
    ['a NUL', '\u0000'],
    ['a lone surrogate', String.fromCharCode(0xd800)],
  ])('refuses %s in an actor before jsonb can', async (_name, bad) => {
    const { engine, statements } = build(happy);
    const done = await engine.saveDraft({
      ...save(),
      actor: { kind: 'system', job: `a${bad}` },
    });
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    expect(statements).toEqual([]);
  });

  it('refuses an unknown field on createNode', async () => {
    const { engine } = build(happy);
    const done = await engine.createNode({
      tenant,
      family: 'docs_page',
      typeId: TYPE,
      id: NODE,
    } as never);
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
  });

  it('refuses a bad id on reads and a bad page', async () => {
    const { engine } = build(happy);
    expect(await engine.getHead(tenant, 'x' as never)).toMatchObject({ ok: false });
    expect(await engine.listVersions(tenant, 'x' as never, {})).toMatchObject({ ok: false });
    expect(await engine.listVersions(tenant, NODE, { limit: 0 })).toMatchObject({ ok: false });
  });
});

describe('content', () => {
  it('stores the bytes of the parsed tree and hashes them', async () => {
    const { engine, statements, ends } = build(happy);
    const done = await engine.saveDraft(save());
    expect(done).toMatchObject({ ok: true, value: { versionId: VERSION, seq: 1 } });
    expect(ends).toEqual(['commit']);
    const insert = statements.find((s) => has(s, 'insert into "node_versions"'));
    expect(insert?.parameters).toContain(JSON.stringify(page));
  });

  it('sends a new block with no source for the host to print', async () => {
    const bare = { ...page.children[0] };
    Reflect.deleteProperty(bare, 'source');
    const print = vi.fn(parseOk.print);
    const { engine } = build(happy, { parse: { print } });
    const done = await engine.saveDraft(save({ content: { ...page, children: [bare as never] } }));
    expect(done).toMatchObject({ ok: true });
    expect(print).toHaveBeenCalledOnce();
  });

  const refusedBy = (code: MdxIssueCode) => ({
    print: () =>
      Promise.resolve<PrintResult>({
        ok: false,
        error: [{ code, severity: 'error', line: 2, column: 3 }],
      }),
  });

  it.each<[MdxIssueCode, string]>([
    ['mdx.parse_failed', 'engine.validation_failed'],
    ['mdx.block_not_printable', 'engine.validation_failed'],
    ['mdx.print_changed_meaning', 'engine.validation_failed'],
    ['mdx.prop_not_literal', 'engine.validation_failed'],
    ['mdx.too_large', 'engine.too_large'],
    ['mdx.too_deep', 'engine.too_large'],
    ['mdx.too_many_nodes', 'engine.too_large'],
    ['mdx.parse_timeout', 'engine.too_large'],
    ['mdx.out_of_memory', 'engine.too_large'],
    ['mdx.queue_full', 'engine.unavailable'],
    ['mdx.organization_limit', 'engine.unavailable'],
    ['mdx.project_limit', 'engine.unavailable'],
    ['mdx.parse_unavailable', 'engine.unavailable'],
  ])('maps %s to %s and opens no transaction', async (issue, code) => {
    const { engine, statements } = build(happy, { parse: refusedBy(issue) });
    const done = await engine.saveDraft(save());
    expect(done).toMatchObject({
      ok: false,
      error: { code, retryable: code === 'engine.unavailable' },
    });
    if (!done.ok) expect(done.error.issues[0]).toMatchObject({ code: issue, line: 2, column: 3 });
    expect(statements).toEqual([]);
  });

  it('blames the page when it parses into more than the cap', async () => {
    const bytes = Buffer.byteLength(JSON.stringify(page));
    const { engine } = build(happy, {
      config: { ...DEFAULT_ENGINE_CONFIG, maxNodeBytes: 1_048_576, maxTreeBytes: bytes + 8 },
      parse: {
        print: () => Promise.resolve(printed({ ...page, tail: 'x'.repeat(bytes) })),
      },
    });
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.too_large', issues: [{ code: 'tree.too_large' }] },
    });
  });

  it('refuses an answer with hashes that do not hold', async () => {
    const [block] = page.children;
    const lying: MdxRoot = {
      ...page,
      children: [
        {
          ...block,
          source: { ...block?.source, rawOf: 'f'.repeat(64) },
        } as MdxRoot['children'][number],
        ...page.children.slice(1),
      ],
    };
    const { engine } = build(happy, {
      parse: { print: () => Promise.resolve(printed(lying)) },
    });
    const done = await engine.saveDraft(save());
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.unavailable' } });
  });

  it('refuses an answer whose blocks do not join into its text', async () => {
    const { engine } = build(happy, {
      parse: {
        print: () => Promise.resolve({ ok: true, value: { ast: page, text: 'other', issues: [] } }),
      },
    });
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true },
    });
  });
});

describe('the writes flag', () => {
  const statementsOff = async (
    write: (engine: ReturnType<typeof build>['engine']) => Promise<unknown>,
  ) => {
    const flags = createTestFlagClient({}, { env: {} });
    const built = build(happy, { flags });
    expect(await write(built.engine)).toMatchObject({
      ok: false,
      error: { code: 'engine.forbidden' },
    });
    expect(built.statements).toEqual([]);
  };

  it('is off by default, and refuses saves', async () => {
    await statementsOff((engine) => engine.saveDraft(save()));
  });

  it('refuses creates', async () => {
    await statementsOff((engine) =>
      engine.createNode({ tenant, family: 'docs_page', typeId: TYPE }),
    );
  });

  it('refuses rollbacks', async () => {
    await statementsOff((engine) =>
      engine.rollback({
        tenant,
        nodeId: NODE,
        toVersionId: idOf('ver', VERSION),
        expectedHeadVersionId: idOf('ver', VERSION),
        actor: { kind: 'system', job: 'test' },
        idempotencyKey: 'k',
      }),
    );
  });

  it('leaves reads on', async () => {
    const reads: Responder = (s) =>
      has(s, 'from "nodes"')
        ? [
            {
              family: 'docs_page',
              type_id: TYPE,
              lifecycle: 'draft',
              head_version_id: null,
              head_content: null,
              seq: null,
              ast_version: null,
            },
          ]
        : [];
    const { engine } = build(reads, { flags: createTestFlagClient({}, { env: {} }) });
    expect(await engine.getHead(tenant, NODE)).toMatchObject({ ok: true });
  });

  it('lets writes through when on', async () => {
    const { engine } = build(happy, {
      flags: createTestFlagClient({ 'engine.writes': true }, { env: {} }),
    });
    expect(await engine.saveDraft(save())).toMatchObject({ ok: true });
  });

  it('asks with the tenant', async () => {
    const evaluate = vi.fn(() => Promise.resolve({ value: true }));
    const { engine } = build(happy, { flags: { evaluate } });
    await engine.saveDraft(save());
    expect(evaluate).toHaveBeenCalledWith('engine.writes', tenant);
  });
});

describe('failure', () => {
  const failing =
    (error: Error): Responder =>
    (statement) => {
      if (has(statement, 'update "nodes"')) throw error;
      return happy(statement);
    };

  it.each(['DB_TIMEOUT', 'DB_UNAVAILABLE'] as const)(
    'makes %s retryable and rolls back',
    async (code) => {
      const { engine, ends } = build(failing(new DbError(code, 'x')));
      const done = await engine.saveDraft(save());
      expect(done).toMatchObject({
        ok: false,
        error: { code: 'engine.unavailable', retryable: true },
      });
      expect(ends).toEqual(['rollback']);
    },
  );

  it('lets a bug throw, after a rollback', async () => {
    const { engine, ends } = build(failing(new Error('a bug')));
    await expect(engine.saveDraft(save())).rejects.toThrow('a bug');
    expect(ends).toEqual(['rollback']);
  });

  it('rolls back a refused create', async () => {
    const full: Responder = (statement) => {
      if (has(statement, 'from "organizations"'))
        return [{ ...PLAN, plan_tier: 'free', nodes: 50 }];
      if (has(statement, 'insert into "organization_node_counts"')) return [{ nodes: 51 }];
      return happy(statement);
    };
    const { engine, ends, statements } = build(full);
    const done = await engine.createNode({ tenant, family: 'docs_page', typeId: TYPE });
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.limit_reached' } });
    expect(ends).toEqual(['rollback']);
    expect(statements.some((s) => has(s, 'insert into "nodes"'))).toBe(false);
  });

  it('calls a tenant with no organization row not found', async () => {
    const empty: Responder = (statement) =>
      has(statement, 'from "organizations"') ? [] : happy(statement);
    const { engine } = build(empty);
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.not_found' },
    });
  });

  it('settles a key lost to another node as a conflict', async () => {
    const lost: Responder = (statement) =>
      has(statement, 'insert into "node_versions"') ? [] : happy(statement);
    const { engine } = build(lost);
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.idempotency_conflict' },
    });
  });
});

describe('history', () => {
  const ACTOR = { kind: 'system', job: 'test' } as const;
  const STORED = JSON.stringify(treeOf([]));
  const target = {
    json: STORED,
    content_sha256: SHA,
    ast_version: 1,
    schema_version: 3,
    origin: 'ai',
  };
  const withHead: Responder = (statement) => {
    if (has(statement, 'for update')) return [{ ...NODE_ROW, head_version_id: VERSION }];
    if (has(statement, 'content::text')) return [target];
    if (has(statement, 'select "seq" from "node_versions"')) return [{ seq: 4 }];
    if (has(statement, 'insert into "node_versions"')) {
      return [{ id: VERSION, seq: 5, content_sha256: SHA }];
    }
    return happy(statement);
  };
  const ask = {
    tenant,
    nodeId: NODE,
    toVersionId: idOf('ver', VERSION),
    expectedHeadVersionId: idOf('ver', VERSION),
    actor: ACTOR,
    idempotencyKey: 'k',
  };

  it('rolls back through a new version at the next seq', async () => {
    const { engine, statements } = build(withHead);
    expect(await engine.rollback(ask)).toMatchObject({ ok: true, value: { seq: 5 } });
    const insert = statements.find((s) => has(s, 'insert into "node_versions"'));
    expect(insert?.parameters).toEqual(expect.arrayContaining([5, 3, 'ai', STORED]));
  });

  it('refuses a target this node does not have', async () => {
    const none: Responder = (s) => (has(s, 'content::text') ? [] : withHead(s));
    const { engine, statements } = build(none);
    expect(await engine.rollback(ask)).toMatchObject({
      ok: false,
      error: { code: 'engine.not_found' },
    });
    expect(statements.some((s) => has(s, 'insert into'))).toBe(false);
  });

  const first = {
    id: VERSION,
    seq: 1,
    node_id: NODE,
    parent_version_id: null,
    origin: 'human',
    actor: ACTOR,
  };
  const replaying =
    (row: Record<string, unknown>): Responder =>
    (statement) =>
      has(statement, 'where "organization_id" = $1 and "project_id" = $2 and "idempotency_key"')
        ? [row]
        : happy(statement);
  const hashOfPage = createHash('sha256').update(JSON.stringify(page)).digest();

  it('replays with no write', async () => {
    const { engine, statements } = build(replaying({ ...first, content_sha256: hashOfPage }));
    expect(await engine.saveDraft(save())).toMatchObject({ ok: true, value: { seq: 1 } });
    expect(statements.some((s) => has(s, 'insert into'))).toBe(false);
  });

  it.each([
    ['content', { content_sha256: SHA }],
    ['node', { content_sha256: hashOfPage, node_id: VERSION }],
    ['parent', { content_sha256: hashOfPage, parent_version_id: VERSION }],
    ['origin', { content_sha256: hashOfPage, origin: 'ai' }],
    ['actor', { content_sha256: hashOfPage, actor: { kind: 'system', job: 'other' } }],
  ])('refuses a key used with another %s', async (_name, over) => {
    const { engine } = build(replaying({ ...first, ...over }));
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.idempotency_conflict' },
    });
  });

  const versions = (rows: number) =>
    Array.from({ length: rows }, (_, index) => ({
      id: VERSION,
      seq: rows - index,
      parent_version_id: index === rows - 1 ? null : VERSION,
      origin: 'human',
      ast_version: 1,
      content_sha256: SHA,
      created_at: new Date(0),
    }));
  const listing =
    (rows: number): Responder =>
    (statement) =>
      has(statement, 'from "node_versions"')
        ? versions(rows)
        : has(statement, 'from "nodes"')
          ? [{ id: NODE }]
          : [];

  it('pages with one row more than it returns', async () => {
    const { engine, statements } = build(listing(3));
    const listed = await engine.listVersions(tenant, NODE, { limit: 2, before: 9 });
    expect(listed).toMatchObject({ ok: true, value: { nextBefore: 2 } });
    if (listed.ok) expect(listed.value.items).toHaveLength(2);
    expect(statements.at(-1)?.parameters).toEqual(expect.arrayContaining([9, 3]));
  });

  it('ends a page with no next one', async () => {
    const { engine } = build(listing(1));
    expect(await engine.listVersions(tenant, NODE, {})).toMatchObject({
      ok: true,
      value: { nextBefore: null, items: [{ parentVersionId: null }] },
    });
  });

  it.each(['getHead', 'listVersions'] as const)('%s answers not found', async (call) => {
    const { engine } = build(() => []);
    const read =
      call === 'getHead' ? engine.getHead(tenant, NODE) : engine.listVersions(tenant, NODE, {});
    expect(await read).toMatchObject({ ok: false, error: { code: 'engine.not_found' } });
  });

  it('names a parent it cannot see not found', async () => {
    const noParent: Responder = (s) => (has(s, 'from "nodes"') ? [] : happy(s));
    const { engine } = build(noParent);
    expect(
      await engine.createNode({ tenant, family: 'docs_page', typeId: TYPE, parentId: NODE }),
    ).toMatchObject({ ok: false, error: { code: 'engine.not_found' } });
  });

  it('reads a head with a version', async () => {
    const row = {
      family: 'docs_page',
      type_id: TYPE,
      lifecycle: 'draft',
      head_version_id: VERSION,
      head_content: page,
      seq: 2,
      ast_version: 1,
    };
    const { engine } = build(() => [row]);
    expect(await engine.getHead(tenant, NODE)).toMatchObject({
      ok: true,
      value: { versionId: VERSION, seq: 2, content: page },
    });
  });
});

describe('observability', () => {
  const capture = () => {
    const lines: { event: string; fields: unknown }[] = [];
    const logger: EngineLogger = {
      info: (event, fields) => lines.push({ event, fields }),
      warn: (event, fields) => lines.push({ event, fields }),
    };
    return { lines, logger };
  };

  it('logs a save with ids, hash and timing, and no content', async () => {
    const { lines, logger } = capture();
    const { engine } = build(happy, { logger });
    await engine.saveDraft(save());
    expect(lines).toEqual([
      {
        event: 'engine.save',
        fields: expect.objectContaining({
          organization_id: tenant.organizationId,
          project_id: tenant.projectId,
          node_id: NODE,
          version_id: VERSION,
          seq: 1,
          content_sha256: SHA.toString('hex'),
          origin: 'human',
          actor_kind: 'system',
          duration_ms: expect.any(Number) as number,
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(page.tail || 'no-tail');
  });

  it('logs a refusal by code', async () => {
    const { lines, logger } = capture();
    const conflict: Responder = (statement) =>
      has(statement, 'for update') ? [{ ...NODE_ROW, head_version_id: VERSION }] : happy(statement);
    const { engine } = build(conflict, { logger });
    await engine.saveDraft(save());
    expect(lines[0]).toMatchObject({
      event: 'engine.save.refused',
      fields: { code: 'engine.version_conflict', node_id: NODE },
    });
  });

  it('runs a save inside the span engine.save', async () => {
    const spans: string[] = [];
    const tracer: EngineTracer = {
      span: (name, fields, work) => {
        spans.push(`${name} ${String(fields['node_id'])}`);
        return noopTracer.span(name, fields, work);
      },
    };
    const { engine } = build(happy, { tracer });
    await engine.saveDraft(save());
    expect(spans).toEqual([
      `engine.save ${NODE}`,
      `engine.save.verify ${NODE}`,
      `engine.save.chunk ${NODE}`,
      `engine.save.write ${NODE}`,
    ]);
  });
});

describe('chunks at write', () => {
  const chunkWrites = (statements: readonly Statement[]) =>
    statements.filter((statement) => has(statement, 'insert into "chunks"'));
  const outboxWrites = (statements: readonly Statement[]) =>
    statements.filter((statement) => has(statement, 'insert into "engine_outbox"'));
  const onlyWrites = {
    evaluate: (name: string) => Promise.resolve({ value: name === 'engine.writes' }),
  };

  it('writes chunks and one outbox row in the save transaction, after the version', async () => {
    const { engine, statements, ends } = build(happy);
    expect(await engine.saveDraft(save())).toMatchObject({ ok: true });
    const version = statements.findIndex((s) => has(s, 'insert into "node_versions"'));
    const chunks = statements.findIndex((s) => has(s, 'insert into "chunks"'));
    expect(chunks).toBeGreaterThan(version);
    expect(outboxWrites(statements)).toHaveLength(1);
    expect(ends).toEqual(['commit']);
  });

  it('carries the tenant and the new version on every chunk and outbox row', async () => {
    const { engine, statements } = build(happy);
    await engine.saveDraft(save());
    for (const statement of [...chunkWrites(statements), ...outboxWrites(statements)]) {
      expect(statement.sql).toContain('"organization_id", "project_id"');
      expect(statement.parameters).toContain(tenant.organizationId);
      expect(statement.parameters).toContain(tenant.projectId);
      expect(statement.parameters).toContain(VERSION);
      expect(statement.parameters).toContain(NODE);
    }
  });

  it('stores the sha256 of each body beside it', async () => {
    const { engine, statements } = build(happy);
    await engine.saveDraft(save());
    const parameters = chunkWrites(statements).flatMap((statement) => [...statement.parameters]);
    const hashes = parameters.filter((value): value is Buffer => Buffer.isBuffer(value));
    const bodies = chunkNode(page, DEFAULT_CHUNKS).map(({ body }) => body);
    expect(hashes.map((hash) => hash.toString('hex'))).toEqual(
      bodies.map((body) => createHash('sha256').update(body).digest('hex')),
    );
  });

  it('writes neither with the flag off', async () => {
    const { engine, statements } = build(happy, { flags: onlyWrites });
    expect(await engine.saveDraft(save())).toMatchObject({ ok: true });
    expect(chunkWrites(statements)).toEqual([]);
    expect(outboxWrites(statements)).toEqual([]);
  });

  it('asks for the flag with the tenant', async () => {
    const evaluate = vi.fn(() => Promise.resolve({ value: true }));
    const { engine } = build(happy, { flags: { evaluate } });
    await engine.saveDraft(save());
    expect(evaluate).toHaveBeenCalledWith('engine.chunk_at_write', tenant);
  });

  describe('when the chunk flag cannot be read', () => {
    const withoutChunkFlag = (answer: () => Promise<{ value: boolean; errorCode?: string }>) => ({
      evaluate: (name: string) =>
        name === 'engine.writes' ? Promise.resolve({ value: true }) : answer(),
    });
    const unread = [
      ['a provider error', () => Promise.resolve({ value: false, errorCode: 'FLAG_TIMEOUT' })],
      ['a missing flag', () => Promise.resolve({ value: false, errorCode: 'FLAG_NOT_FOUND' })],
      ['a rejected read', () => Promise.reject(new Error('flagd is down'))],
    ] as const;

    it.each(unread)('refuses a save on %s, stores nothing and says so', async (_name, answer) => {
      const lines: { event: string; fields: LogFields }[] = [];
      const logger: EngineLogger = {
        info: () => undefined,
        warn: (event, fields) => lines.push({ event, fields }),
      };
      const flags = withoutChunkFlag(answer);
      const { engine, statements } = build(happy, { flags, logger });
      expect(await engine.saveDraft(save())).toMatchObject({
        ok: false,
        error: { code: 'engine.unavailable', retryable: true },
      });
      expect(statements).toEqual([]);
      expect(lines).toEqual([
        {
          event: 'engine.flag_read_failed',
          fields: expect.objectContaining({
            organization_id: tenant.organizationId,
            project_id: tenant.projectId,
            flag: 'engine.chunk_at_write',
          }) as LogFields,
        },
      ]);
    });

    it.each(unread)('refuses a rollback on %s and stores nothing', async (_name, answer) => {
      const flags = withoutChunkFlag(answer);
      const { engine, statements } = build(happy, { flags });
      expect(
        await engine.rollback({
          tenant,
          nodeId: NODE,
          toVersionId: idOf('ver', VERSION),
          expectedHeadVersionId: idOf('ver', VERSION),
          actor: { kind: 'system', job: 'test' },
          idempotencyKey: 'rollback',
        }),
      ).toMatchObject({ ok: false, error: { code: 'engine.unavailable' } });
      expect(statements).toEqual([]);
    });

    it('keeps refusing writes as forbidden when the writes flag cannot be read', async () => {
      const flags = { evaluate: () => Promise.reject(new Error('flagd is down')) };
      const { engine, statements } = build(happy, { flags });
      expect(await engine.saveDraft(save())).toMatchObject({
        ok: false,
        error: { code: 'engine.forbidden' },
      });
      expect(statements).toEqual([]);
    });
  });

  it('writes nothing more for a replay', async () => {
    const replayed: Responder = (statement) =>
      has(statement, '"idempotency_key" = ')
        ? [
            {
              id: VERSION,
              seq: 1,
              node_id: NODE,
              parent_version_id: null,
              origin: 'human',
              actor: { kind: 'system', job: 'test' },
              content_sha256: createHash('sha256').update(JSON.stringify(page)).digest(),
            },
          ]
        : happy(statement);
    const { engine, statements } = build(replayed);
    expect(await engine.saveDraft(save())).toMatchObject({ ok: true });
    expect(chunkWrites(statements)).toEqual([]);
    expect(outboxWrites(statements)).toEqual([]);
  });

  it('writes nothing for a conflict', async () => {
    const conflict: Responder = (statement) =>
      has(statement, 'for update') ? [{ ...NODE_ROW, head_version_id: VERSION }] : happy(statement);
    const { engine, statements } = build(conflict);
    await engine.saveDraft(save());
    expect(chunkWrites(statements)).toEqual([]);
  });

  it('stores no version when a chunk write fails', async () => {
    const failing: Responder = (statement) => {
      if (has(statement, 'insert into "chunks"')) throw new DbError('DB_TIMEOUT', 'x');
      return happy(statement);
    };
    const { engine, ends } = build(failing);
    expect(await engine.saveDraft(save())).toMatchObject({
      ok: false,
      error: { code: 'engine.unavailable' },
    });
    expect(ends).toEqual(['rollback']);
  });

  it('stores no version when the outbox write fails', async () => {
    const failing: Responder = (statement) => {
      if (has(statement, 'insert into "engine_outbox"')) throw new DbError('DB_TIMEOUT', 'x');
      return happy(statement);
    };
    const { engine, ends } = build(failing);
    await engine.saveDraft(save());
    expect(ends).toEqual(['rollback']);
  });

  describe('on a rollback', () => {
    const TARGET = '01890a5d-ac96-774b-bcce-b302099a8006';
    const HEAD = '01890a5d-ac96-774b-bcce-b302099a8007';
    const ask = {
      tenant,
      nodeId: NODE,
      toVersionId: idOf('ver', TARGET),
      expectedHeadVersionId: idOf('ver', HEAD),
      actor: { kind: 'system', job: 'test' },
      idempotencyKey: 'back-1',
    } as const;
    const stored: Responder = (statement) => {
      if (has(statement, 'for update')) return [{ ...NODE_ROW, head_version_id: HEAD }];
      if (has(statement, 'content::text')) {
        return [
          {
            json: JSON.stringify(page),
            content_sha256: SHA,
            ast_version: 1,
            schema_version: 1,
            origin: 'ai',
          },
        ];
      }
      if (has(statement, 'select "seq"')) return [{ seq: 4 }];
      if (has(statement, 'insert into "node_versions"')) {
        return [{ id: VERSION, seq: 5, content_sha256: SHA }];
      }
      return happy(statement);
    };

    it('chunks the content it brings back, for the new version', async () => {
      const { engine, statements } = build(stored);
      expect(await engine.rollback(ask)).toMatchObject({ ok: true });
      const writes = chunkWrites(statements);
      expect(writes.length).toBeGreaterThan(0);
      for (const { parameters } of writes) expect(parameters).toContain(VERSION);
      expect(outboxWrites(statements)).toHaveLength(1);
    });

    it('writes neither with the flag off', async () => {
      const { engine, statements } = build(stored, { flags: onlyWrites });
      expect(await engine.rollback(ask)).toMatchObject({ ok: true });
      expect(chunkWrites(statements)).toEqual([]);
      expect(outboxWrites(statements)).toEqual([]);
    });
  });

  it('logs a count and never a body', async () => {
    const lines: { event: string; fields: LogFields }[] = [];
    const logger: EngineLogger = {
      info: (event, fields) => lines.push({ event, fields }),
      warn: (event, fields) => lines.push({ event, fields }),
    };
    const { engine } = build(happy, { logger });
    await engine.saveDraft(save());
    const line = lines.find(({ event }) => event === 'engine.save');
    expect(line?.fields).toMatchObject({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: NODE,
      chunks: chunkNode(page, DEFAULT_CHUNKS).length,
    });
    const logged = JSON.stringify(lines);
    for (const { body } of chunkNode(page, DEFAULT_CHUNKS)) {
      expect(logged).not.toContain(JSON.stringify(body).slice(1, -1));
    }
  });
});
