import { DbError } from '@drefyn/db';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  createEngine,
  type Actor,
  type EngineDeps,
  type EngineLogger,
  type LogFields,
  type PublishInput,
  type SetDefaultVisibilityInput,
  type SetVisibilityInput,
} from '../src/index.ts';
import { MAX_SUBTREE_ROWS } from '../src/tree.ts';
import { scriptedStore, type Responder, type Statement } from './support/scripted-store.ts';

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const NODE = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8003');
const HEAD = idOf('ver', '01890a5d-ac96-774b-bcce-b302099a8006');
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8005';
const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099');
const MACHINE = '01890a5d-ac96-774b-bcce-b302099a8098';
const CHUNK = '01890a5d-ac96-774b-bcce-b302099a8020';
const AT = new Date('2026-11-17T10:00:00Z');

const EDITOR: Actor = { kind: 'user', userId: USER, roles: ['editor'] };
const VIEWER: Actor = { kind: 'user', userId: USER, roles: ['viewer'] };
const DOCS_KEY: Actor = { kind: 'api_key', keyId: MACHINE, scopes: ['docs:pages.publish'] };
const GIT: Actor = {
  kind: 'git',
  installationId: '42',
  commitSha: 'a'.repeat(40),
  authorEmail: 'dev@example.com',
};
const JOB: Actor = { kind: 'system', job: 'test' };

const has = (statement: Statement, text: string) => statement.sql.includes(text);

const PLAN = { plan_tier: 'self_hosted', organization_read_only: null, project_read_only: null };
const NODE_ROW = { id: NODE, family: 'docs_page', type_id: TYPE, head_version_id: HEAD };
const OPEN = { approval_required: false, api_keys_publish: true, git_publish: true };

const setInput = (over: Partial<SetVisibilityInput> = {}): SetVisibilityInput => ({
  tenant,
  nodeId: NODE,
  override: 'protected',
  actor: EDITOR,
  idempotencyKey: 'visibility-1',
  ...over,
});

const defaultInput = (
  over: Partial<SetDefaultVisibilityInput> = {},
): SetDefaultVisibilityInput => ({
  tenant,
  visibility: 'protected',
  actor: EDITOR,
  idempotencyKey: 'visibility-site-1',
  ...over,
});

const logRow = (over: Record<string, unknown> = {}) => ({
  node_id: NODE,
  override: 'protected',
  effective: 'protected',
  widened: false,
  nodes_changed: 1,
  actor_kind: 'user',
  actor_id: USER,
  changed_at: AT,
  ...over,
});

interface Script {
  readonly prior?: Record<string, unknown> | null;
  readonly node?: Record<string, unknown> | null;
  readonly plan?: Record<string, unknown>;
  readonly workflow?: Record<string, unknown> | null;
  readonly reach?: Record<string, unknown> | null;
  readonly siteDefault?: unknown;
  readonly flipped?: Record<string, unknown> | null;
  readonly logged?: Record<string, unknown> | null;
  readonly fail?: (statement: Statement) => Error | null;
}

const scripted =
  (script: Script = {}): Responder =>
  (statement) => {
    const failure = script.fail?.(statement) ?? null;
    if (failure !== null) throw failure;
    if (has(statement, 'as deep')) {
      return script.reach === null
        ? []
        : [{ nodes: 3, deep: false, widens: false, effective: 'protected', ...script.reach }];
    }
    if (has(statement, 'as gone')) {
      return script.flipped === null ? [] : [{ nodes: 1, gone: [], added: [], ...script.flipped }];
    }
    if (has(statement, 'pg_advisory_xact_lock')) return [{}];
    if (has(statement, 'from "visibility_log"')) {
      return script.prior === undefined || script.prior === null ? [] : [script.prior];
    }
    if (has(statement, 'for update')) {
      return script.node === null ? [] : [{ ...NODE_ROW, ...script.node }];
    }
    if (has(statement, 'from "organizations"')) return [{ ...PLAN, nodes: 1, ...script.plan }];
    if (has(statement, 'from "publish_workflows"')) {
      return script.workflow === undefined || script.workflow === null ? [] : [script.workflow];
    }
    if (has(statement, 'as visibility') && has(statement, 'app.site_access')) {
      return [{ visibility: script.siteDefault ?? 'public' }];
    }
    if (has(statement, 'insert into "visibility_log"')) {
      return script.logged === null ? [] : [logRow(script.logged)];
    }
    return [];
  };

const capture = () => {
  const lines: { event: string; fields: LogFields }[] = [];
  const logger: EngineLogger = {
    info: (event, fields) => lines.push({ event, fields }),
    warn: (event, fields) => lines.push({ event, fields }),
  };
  return { lines, logger };
};

const flagsOf = (values: Readonly<Record<string, boolean | Error>>) => ({
  evaluate: (name: string) => {
    const value = values[name] ?? true;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve({ value });
  },
});

const build = (respond: Responder, over: Partial<EngineDeps> = {}) => {
  const store = scriptedStore(respond);
  const engine = createEngine({
    store: store.store,
    parse: { print: () => Promise.reject(new Error('visibility never parses')) },
    parsePolicy: {
      version: 3,
      components: [],
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https'],
    },
    flags: flagsOf({}),
    ...over,
  });
  return { engine, ...store };
};

const WRITES = [
  'update "nodes"',
  'insert into "site_access"',
  'as gone',
  'insert into "visibility_log"',
];

const wrote = (statements: readonly Statement[]) =>
  statements.filter((statement) => WRITES.some((write) => has(statement, write)));

describe('setVisibility', () => {
  it('locks the tree, then visibility, then reads, checks and writes in one transaction', async () => {
    const { engine, statements, ends } = build(scripted());
    const done = await engine.setVisibility(setInput());
    expect(done).toEqual({
      ok: true,
      value: {
        nodeId: NODE,
        override: 'protected',
        effective: 'protected',
        widened: false,
        nodesChanged: 1,
        changedAt: AT,
      },
    });
    expect(ends).toEqual(['commit']);
    expect(statements[0]?.sql).toMatch(/^set local lock_timeout/);
    expect(statements[1]?.parameters.join()).toContain('engine.tree:');
    expect(statements[2]?.sql).toMatch(/^select pg_advisory_xact_lock\(/);
    expect(statements[2]?.parameters.join()).toContain(
      `engine.visibility:${tenant.organizationId}:${tenant.projectId}`,
    );
    expect(wrote(statements).map((s) => WRITES.find((w) => has(s, w)))).toEqual([
      'update "nodes"',
      'as gone',
      'insert into "visibility_log"',
    ]);
    const node = statements.find((s) => has(s, 'update "nodes"'));
    expect(node?.sql).toContain('"visibility_override" = $1');
    expect(node?.parameters).toEqual(
      expect.arrayContaining(['protected', tenant.organizationId, tenant.projectId, NODE]),
    );
    const log = statements.find((s) => has(s, 'insert into "visibility_log"'));
    expect(log?.parameters).toEqual(
      expect.arrayContaining([NODE, 'protected', false, 1, 'user', USER, 'visibility-1']),
    );
  });

  it('names both tenant ids in every statement after the locks', async () => {
    const { engine, statements } = build(scripted());
    await engine.setVisibility(setInput());
    for (const statement of statements.slice(3)) {
      expect(statement.parameters).toEqual(
        expect.arrayContaining([tenant.organizationId, tenant.projectId]),
      );
    }
  });

  it('walks down from the node, each child keeping its own override, within bounds', async () => {
    const { engine, statements } = build(scripted());
    await engine.setVisibility(setInput({ override: null }));
    const walk = statements.find((s) => has(s, 'as deep'));
    expect(walk?.sql).toContain('with recursive down');
    expect(walk?.sql).toContain('coalesce(c.visibility_override, d.after)');
    expect(walk?.parameters).toEqual(expect.arrayContaining([null, NODE, MAX_SUBTREE_ROWS + 1]));
    const flip = statements.find((s) => has(s, 'as gone'));
    expect(flip?.sql).toContain('update app.published_versions');
    expect(flip?.sql).toContain('update app.published_filter_rows');
    expect(flip?.sql).toContain('update app.published_chunks');
  });

  it('moves the current chunks that flipped through the term tables', async () => {
    const { engine, statements } = build(scripted({ flipped: { gone: [CHUNK] } }));
    expect((await engine.setVisibility(setInput())).ok).toBe(true);
    const lock = statements.find((s) => has(s, 'pg_advisory_xact_lock') && has(s, 'hashtext'));
    expect(lock).toBeDefined();
    expect(statements.some((s) => s.parameters.join().includes('engine.terms:'))).toBe(true);
    expect(statements.some((s) => has(s, 'delete from app.published_chunk_terms'))).toBe(true);
  });

  it.each<[string, Actor, Record<string, unknown> | null]>([
    ['a person who may publish', EDITOR, null],
    ['a key the project allows', DOCS_KEY, OPEN],
    ['a push the project allows', GIT, OPEN],
  ])('tightens for %s', async (_name, actor, workflow) => {
    const { engine } = build(scripted({ workflow }));
    expect((await engine.setVisibility(setInput({ actor }))).ok).toBe(true);
  });

  it.each<[string, Actor, Record<string, unknown> | null, string]>([
    ['a viewer', VIEWER, null, 'engine.forbidden'],
    ['a job', JOB, OPEN, 'engine.forbidden'],
    ['a key the project does not allow', DOCS_KEY, null, 'engine.forbidden'],
    [
      'a key without the scope',
      { ...DOCS_KEY, scopes: ['docs:pages.read'] },
      OPEN,
      'engine.forbidden',
    ],
    ['a push the project does not allow', GIT, null, 'engine.forbidden'],
  ])('refuses a tighten by %s and writes nothing', async (_name, actor, workflow, code) => {
    const { engine, statements, ends } = build(scripted({ workflow }));
    const done = await engine.setVisibility(setInput({ actor }));
    expect(done.ok || done.error.code).toBe(code);
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it.each<[string, Actor]>([
    ['a key', DOCS_KEY],
    ['a push', GIT],
    ['a job', JOB],
    ['a viewer', VIEWER],
  ])('refuses a widening by %s even where the project allows it', async (_name, actor) => {
    const { engine, statements, ends } = build(
      scripted({ workflow: OPEN, reach: { widens: true, effective: 'public' } }),
    );
    const done = await engine.setVisibility(setInput({ actor, override: null }));
    expect(done.ok || done.error).toEqual({
      code: 'engine.widen_requires_publish',
      retryable: false,
      issues: [],
    });
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it('treats an override of public as a widening even when nothing opens yet', async () => {
    const { engine, statements } = build(scripted({ workflow: OPEN, reach: { widens: false } }));
    const done = await engine.setVisibility(setInput({ actor: GIT, override: 'public' }));
    expect(done.ok || done.error.code).toBe('engine.widen_requires_publish');
    expect(wrote(statements)).toEqual([]);
  });

  it('lets a person who may publish widen, and says so', async () => {
    const { engine, statements } = build(
      scripted({
        reach: { widens: true, effective: 'public' },
        flipped: { added: [CHUNK] },
        logged: { override: null, effective: 'public', widened: true },
      }),
    );
    const done = await engine.setVisibility(setInput({ override: null }));
    expect(done.ok && done.value).toMatchObject({
      override: null,
      effective: 'public',
      widened: true,
    });
    const log = statements.find((s) => has(s, 'insert into "visibility_log"'));
    expect(log?.parameters).toEqual(expect.arrayContaining([null, 'public', true]));
  });

  it('answers not_found for a missing node and writes nothing', async () => {
    const { engine, statements, ends } = build(scripted({ node: null }));
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error.code).toBe('engine.not_found');
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it('refuses a read only project after a downgrade before reading the tree', async () => {
    const { engine, statements } = build(scripted({ plan: { organization_read_only: AT } }));
    const done = await engine.setVisibility(setInput({ override: 'public' }));
    expect(done.ok || done.error.code).toBe('engine.read_only');
    expect(statements.some((s) => has(s, 'as deep'))).toBe(false);
    expect(wrote(statements)).toEqual([]);
  });

  it.each([
    ['a subtree past the row budget', { nodes: MAX_SUBTREE_ROWS + 1 }],
    ['a branch deeper than it can read', { deep: true }],
  ])('refuses %s as too large, since a branch it cannot see stays open', async (_name, reach) => {
    const { engine, statements } = build(scripted({ reach }));
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error).toMatchObject({ code: 'engine.too_large' });
    expect(wrote(statements)).toEqual([]);
  });

  it('gives a replay the first answer and writes nothing', async () => {
    const prior = logRow({ nodes_changed: 4 });
    const { engine, statements, ends } = build(scripted({ prior }));
    const done = await engine.setVisibility(setInput());
    expect(done.ok && done.value).toMatchObject({ nodesChanged: 4, changedAt: AT });
    expect(wrote(statements)).toEqual([]);
    expect(statements.some((s) => has(s, 'for update'))).toBe(false);
    expect(ends).toEqual(['commit']);
  });

  it.each<[string, Partial<SetVisibilityInput>]>([
    ['another node', { nodeId: idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8011') }],
    ['another override', { override: null }],
    ['another actor', { actor: { ...EDITOR, userId: idOf('usr', MACHINE) } }],
    ['another kind of actor', { actor: GIT }],
  ])('refuses the same key with %s', async (_name, over) => {
    const { engine, statements } = build(scripted({ prior: logRow() }));
    const done = await engine.setVisibility(setInput(over));
    expect(done.ok || done.error.code).toBe('engine.idempotency_conflict');
    expect(wrote(statements).filter((s) => !has(s, 'insert into "visibility_log"'))).toEqual([]);
  });

  it('refuses a key it could not log, and keeps none of the change', async () => {
    const { engine, ends } = build(scripted({ logged: null }));
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error.code).toBe('engine.idempotency_conflict');
    expect(ends).toEqual(['rollback']);
  });

  it('answers a busy database as retryable and rolls back', async () => {
    const busy = new DbError('DB_UNAVAILABLE', 'down');
    const { engine, ends } = build(scripted({ fail: (s) => (has(s, 'as gone') ? busy : null) }));
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error).toMatchObject({ code: 'engine.unavailable', retryable: true });
    expect(ends).toEqual(['rollback']);
  });

  it.each([
    ['no answer from the walk', { reach: null }],
    ['a walk that names no visibility', { reach: { effective: 'secret' } }],
    ['no answer from the flip', { flipped: null }],
  ])('fails on %s and keeps nothing', async (_name, script) => {
    const { engine, ends } = build(scripted(script));
    await expect(engine.setVisibility(setInput())).rejects.toThrow(/unreadable/);
    expect(ends).toEqual(['rollback']);
  });

  it('refuses bad input before any statement', async () => {
    const { engine, statements } = build(scripted());
    const done = await engine.setVisibility({
      ...setInput(),
      override: 'secret' as never,
      idempotencyKey: '',
    });
    expect(done.ok || done.error.code).toBe('engine.validation_failed');
    expect(done.ok || done.error.issues.map((i) => i.path)).toEqual(['override', 'idempotencyKey']);
    expect(statements).toEqual([]);
  });

  it('refuses while engine writes are off, before any statement', async () => {
    const { engine, statements } = build(scripted(), {
      flags: flagsOf({ 'engine.writes': false }),
    });
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error.code).toBe('engine.forbidden');
    expect(statements).toEqual([]);
  });

  it('refuses a change while docs.private_access is off, before any statement', async () => {
    const { engine, statements } = build(scripted(), {
      flags: flagsOf({ 'docs.private_access': false }),
    });
    for (const override of ['protected', 'public', null] as const) {
      const done = await engine.setVisibility(setInput({ override }));
      expect(done.ok || done.error.code).toBe('engine.forbidden');
    }
    const site = await engine.setDefaultVisibility(defaultInput());
    expect(site.ok || site.error.code).toBe('engine.forbidden');
    expect(statements).toEqual([]);
  });

  it('answers retryable when docs.private_access cannot be read, and says which flag', async () => {
    const { lines, logger } = capture();
    const { engine, statements } = build(scripted(), {
      logger,
      flags: flagsOf({ 'docs.private_access': new Error('flagd is down') }),
    });
    const done = await engine.setVisibility(setInput());
    expect(done.ok || done.error).toMatchObject({ code: 'engine.unavailable', retryable: true });
    expect(statements).toEqual([]);
    expect(lines).toContainEqual({
      event: 'engine.flag_read_failed',
      fields: expect.objectContaining({ flag: 'docs.private_access' }) as LogFields,
    });
  });

  it('logs ids, codes and counts, never a key or an address', async () => {
    const { lines, logger } = capture();
    const { engine } = build(scripted({ workflow: OPEN }), { logger });
    await engine.setVisibility(setInput({ actor: GIT }));
    await engine.setVisibility(setInput({ actor: GIT, override: 'public' }));
    expect(lines[0]).toEqual({
      event: 'engine.visibility',
      fields: expect.objectContaining({
        organization_id: tenant.organizationId,
        project_id: tenant.projectId,
        node_id: NODE,
        override: 'protected',
        actor_kind: 'git',
        actor_id: '42',
        effective: 'protected',
        widened: false,
        nodes_changed: 1,
      }) as LogFields,
    });
    expect(lines[1]).toEqual({
      event: 'engine.visibility.refused',
      fields: expect.objectContaining({ code: 'engine.widen_requires_publish' }) as LogFields,
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('dev@example.com');
    expect(text).not.toContain('visibility-1');
  });

  it('logs a cleared override as inherit', async () => {
    const { lines, logger } = capture();
    const { engine } = build(scripted(), { logger });
    await engine.setVisibility(setInput({ override: null }));
    expect(lines[0]?.fields).toMatchObject({ override: 'inherit' });
  });
});

describe('setDefaultVisibility', () => {
  it('reads the old default, walks from every root and upserts the site row', async () => {
    const { engine, statements } = build(
      scripted({ logged: { node_id: null, override: 'protected', effective: 'protected' } }),
    );
    const done = await engine.setDefaultVisibility(defaultInput());
    expect(done.ok && done.value).toMatchObject({
      nodeId: null,
      override: 'protected',
      effective: 'protected',
    });
    expect(statements.some((s) => has(s, 'for update'))).toBe(false);
    const walk = statements.find((s) => has(s, 'as deep'));
    expect(walk?.sql).toContain('n.parent_id is null');
    expect(walk?.parameters).toEqual(expect.arrayContaining(['public', 'protected']));
    const site = statements.find((s) => has(s, 'insert into "site_access"'));
    expect(site?.sql).toContain('on conflict');
    expect(site?.parameters).toEqual(
      expect.arrayContaining([tenant.organizationId, tenant.projectId, 'protected']),
    );
    const log = statements.find((s) => has(s, 'insert into "visibility_log"'));
    expect(log?.parameters).toEqual(expect.arrayContaining([null, 'protected', 'protected']));
  });

  it('refuses a public default from anyone but a person who may publish', async () => {
    const { engine, statements } = build(scripted({ workflow: OPEN, siteDefault: 'protected' }));
    for (const actor of [DOCS_KEY, GIT, JOB, VIEWER]) {
      const done = await engine.setDefaultVisibility(defaultInput({ actor, visibility: 'public' }));
      expect(done.ok || done.error.code).toBe('engine.widen_requires_publish');
    }
    expect(wrote(statements)).toEqual([]);
  });

  it('lets a key the project allows shut the site', async () => {
    const { engine } = build(scripted({ workflow: OPEN }));
    expect((await engine.setDefaultVisibility(defaultInput({ actor: DOCS_KEY }))).ok).toBe(true);
  });

  it('fails on an unreadable default and keeps nothing', async () => {
    const { engine, ends } = build(scripted({ siteDefault: 'secret' }));
    await expect(engine.setDefaultVisibility(defaultInput())).rejects.toThrow(/unreadable/);
    expect(ends).toEqual(['rollback']);
  });

  it('refuses the same key used for a node', async () => {
    const { engine } = build(scripted({ prior: logRow() }));
    const done = await engine.setDefaultVisibility(defaultInput());
    expect(done.ok || done.error.code).toBe('engine.idempotency_conflict');
  });

  it('refuses bad input before any statement', async () => {
    const { engine, statements } = build(scripted());
    const done = await engine.setDefaultVisibility({
      ...defaultInput(),
      visibility: null as never,
    });
    expect(done.ok || done.error.code).toBe('engine.validation_failed');
    expect(statements).toEqual([]);
  });
});

describe('publish computes visibility', () => {
  const publishInput: PublishInput = {
    tenant,
    nodeId: NODE,
    versionId: HEAD,
    expectedHeadVersionId: HEAD,
    actor: EDITOR,
    idempotencyKey: 'publish-1',
  };

  const FACTS = {
    origin: 'human',
    fields: {},
    filter_slots: {},
    approval_required: null,
    api_keys_publish: null,
    git_publish: null,
    approved: false,
    current_version_id: null,
  };

  const LOGGED = {
    node_id: NODE,
    version_id: HEAD,
    expected_head_version_id: HEAD,
    previous_version_id: null,
    actor_kind: 'user',
    actor_id: USER,
    render_policy_version: 3,
    published_at: AT,
  };

  interface PublishScript {
    readonly visibility?: readonly Record<string, unknown>[];
    readonly flipped?: Record<string, unknown>;
    readonly fail?: (statement: Statement) => Error | null;
  }

  const publishing =
    (script: PublishScript = {}): Responder =>
    (statement) => {
      const failure = script.fail?.(statement) ?? null;
      if (failure !== null) throw failure;
      if (has(statement, 'as held')) {
        return script.visibility ?? [{ visibility: 'public', held: false }];
      }
      if (has(statement, 'as gone')) return [{ nodes: 0, gone: [], added: [], ...script.flipped }];
      if (has(statement, 'for update')) return [NODE_ROW];
      if (has(statement, '"publish_workflows"')) return [FACTS];
      if (has(statement, 'from "organizations"')) return [{ ...PLAN, nodes: 1 }];
      if (has(statement, 'insert into "publish_log"')) return [LOGGED];
      return [];
    };

  const PUBLISH_WRITES = [
    'insert into "publish_log"',
    'as gone',
    'insert into app.published_versions',
    'insert into app.published_filter_rows',
    'update "nodes"',
  ];
  const published = (statements: readonly Statement[]) =>
    statements.filter((s) => PUBLISH_WRITES.some((w) => has(s, w)));

  it('shares the visibility lock before the node lock, and reads the tree under both', async () => {
    const { engine, statements } = build(publishing());
    expect((await engine.publish(publishInput)).ok).toBe(true);
    expect(statements[0]?.sql).toMatch(/^select pg_advisory_xact_lock_shared\(/);
    expect(statements[0]?.parameters.join()).toContain('engine.visibility:');
    expect(statements[1]?.sql).toContain('for update');
    const read = statements.find((s) => has(s, 'as held'));
    expect(read?.sql).toContain('with recursive up');
    expect(read?.sql).toContain('app.site_access');
    expect(read?.parameters).toEqual(
      expect.arrayContaining([tenant.organizationId, tenant.projectId, NODE]),
    );
  });

  it.each([
    ['protected', { visibility: 'protected', held: false }],
    ['public', { visibility: 'public', held: false }],
  ] as const)('writes %s to the version, filter row and node rows alike', async (want, row) => {
    const { engine, statements } = build(publishing({ visibility: [row] }));
    const done = await engine.publish(publishInput);
    expect(done.ok && done.value.visibility).toBe(want);
    for (const write of [
      'insert into app.published_versions',
      'insert into app.published_filter_rows',
    ]) {
      expect(statements.find((s) => has(s, write))?.parameters).toContain(want);
    }
    expect(statements.find((s) => has(s, 'as gone'))?.parameters).toEqual(
      expect.arrayContaining([NODE, want]),
    );
  });

  it('keeps a node protected when the tree says public and its rows say protected', async () => {
    const { lines, logger } = capture();
    const { engine, statements } = build(
      publishing({ visibility: [{ visibility: 'public', held: true }] }),
      { logger },
    );
    const done = await engine.publish(publishInput);
    expect(done.ok && done.value.visibility).toBe('protected');
    expect(
      statements.find((s) => has(s, 'insert into app.published_versions'))?.parameters,
    ).toContain('protected');
    expect(lines.find((l) => l.event === 'engine.publish')?.fields).toMatchObject({
      visibility: 'protected',
      visibility_held: true,
    });
  });

  it('flips rows from a past copy with the term change even when chunks are off', async () => {
    const { engine, statements } = build(publishing({ flipped: { gone: [CHUNK] } }), {
      flags: flagsOf({ 'retrieval.v1': false }),
    });
    expect((await engine.publish(publishInput)).ok).toBe(true);
    expect(statements.some((s) => has(s, 'delete from app.published_chunk_terms'))).toBe(true);
    expect(statements.some((s) => has(s, 'insert into app.published_chunks'))).toBe(false);
  });

  it('fails the publish as retryable when the visibility read hits a busy database', async () => {
    const busy = new DbError('DB_TIMEOUT', 'slow');
    const { engine, statements, ends } = build(
      publishing({ fail: (s) => (has(s, 'as held') ? busy : null) }),
    );
    const done = await engine.publish(publishInput);
    expect(done.ok || done.error).toMatchObject({ code: 'publish.unavailable', retryable: true });
    expect(published(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it.each([
    ['no row', []],
    ['a value that is not a visibility', [{ visibility: 'secret', held: false }]],
    ['a null value', [{ visibility: null, held: false }]],
    ['no held answer', [{ visibility: 'public' }]],
  ])('fails the publish on %s and writes nothing', async (_name, rows) => {
    const { engine, statements, ends } = build(publishing({ visibility: rows }));
    await expect(engine.publish(publishInput)).rejects.toThrow('visibility unreadable');
    expect(published(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it('fails the publish when the flip cannot be read, after nothing commits', async () => {
    const { engine, ends } = build((statement) =>
      has(statement, 'as gone') ? [] : publishing()(statement),
    );
    await expect(engine.publish(publishInput)).rejects.toThrow('visibility flip unreadable');
    expect(ends).toEqual(['rollback']);
  });

  it('answers a replay with what the row says now, and protected when the row is gone', async () => {
    const replay =
      (rows: readonly Record<string, unknown>[]): Responder =>
      (statement) => {
        if (has(statement, 'from "publish_log"')) return [LOGGED];
        if (has(statement, 'select "visibility" from "published_versions"')) return rows;
        return publishing()(statement);
      };
    const now = build(replay([{ visibility: 'protected' }]));
    const done = await now.engine.publish(publishInput);
    expect(done.ok && done.value.visibility).toBe('protected');
    const gone = build(replay([]));
    const again = await gone.engine.publish(publishInput);
    expect(again.ok && again.value.visibility).toBe('protected');
    const open = build(replay([{ visibility: 'public' }]));
    const live = await open.engine.publish(publishInput);
    expect(live.ok && live.value.visibility).toBe('public');
  });
});
