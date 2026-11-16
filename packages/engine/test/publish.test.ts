import { DbError } from '@drefyn/db';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  createEngine,
  PUBLISH_ERROR_CODES,
  type Actor,
  type ApproveInput,
  type EngineDeps,
  type EngineLogger,
  type LogFields,
  type PublishInput,
} from '../src/index.ts';
import { scriptedStore, type Responder, type Statement } from './support/scripted-store.ts';

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const NODE = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8003');
const VERSION = idOf('ver', '01890a5d-ac96-774b-bcce-b302099a8004');
const HEAD = idOf('ver', '01890a5d-ac96-774b-bcce-b302099a8006');
const EARLIER = idOf('ver', '01890a5d-ac96-774b-bcce-b302099a8007');
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8005';
const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099');
const MACHINE = '01890a5d-ac96-774b-bcce-b302099a8098';
const FIELD = '01890a5d-ac96-774b-bcce-b302099a8010';
const AT = new Date('2026-11-16T10:00:00Z');

const EDITOR: Actor = { kind: 'user', userId: USER, roles: ['editor'] };
const ADMIN: Actor = { kind: 'user', userId: USER, roles: ['admin'] };
const VIEWER: Actor = { kind: 'user', userId: USER, roles: ['viewer'] };
const DOCS_KEY: Actor = { kind: 'api_key', keyId: MACHINE, scopes: ['docs:pages.publish'] };
const GIT: Actor = {
  kind: 'git',
  installationId: '42',
  commitSha: 'a'.repeat(40),
  authorEmail: 'dev@example.com',
};

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  tenant,
  nodeId: NODE,
  versionId: HEAD,
  expectedHeadVersionId: HEAD,
  actor: EDITOR,
  idempotencyKey: 'publish-1',
  ...over,
});

const has = (statement: Statement, text: string) => statement.sql.includes(text);

const NODE_ROW = { id: NODE, family: 'docs_page', type_id: TYPE, head_version_id: HEAD };
const PLAN = { plan_tier: 'self_hosted', organization_read_only: null, project_read_only: null };

interface Facts {
  readonly origin: string;
  readonly fields: unknown;
  readonly filter_slots: unknown;
  readonly approval_required: boolean | null;
  readonly api_keys_publish: boolean | null;
  readonly git_publish: boolean | null;
  readonly approved: boolean;
  readonly current_version_id: string | null;
}

const FACTS: Facts = {
  origin: 'human',
  fields: {},
  filter_slots: {},
  approval_required: null,
  api_keys_publish: null,
  git_publish: null,
  approved: false,
  current_version_id: null,
};

const logRow = (over: Record<string, unknown> = {}) => ({
  node_id: NODE,
  version_id: HEAD,
  expected_head_version_id: HEAD,
  previous_version_id: null,
  actor_kind: 'user',
  actor_id: USER,
  render_policy_version: 3,
  published_at: AT,
  ...over,
});

interface Script {
  readonly node?: Record<string, unknown> | null;
  readonly prior?: Record<string, unknown> | null;
  readonly facts?: Partial<Facts> | null;
  readonly plan?: Record<string, unknown>;
  readonly logged?: Record<string, unknown> | null;
  readonly fail?: (statement: Statement) => Error | null;
}

const scripted =
  (script: Script = {}): Responder =>
  (statement) => {
    const failure = script.fail?.(statement) ?? null;
    if (failure !== null) throw failure;
    if (has(statement, 'from "nodes"') && has(statement, 'for update')) {
      return script.node === null ? [] : [{ ...NODE_ROW, ...script.node }];
    }
    if (has(statement, 'from "publish_log"')) {
      return script.prior === undefined || script.prior === null ? [] : [script.prior];
    }
    if (has(statement, '"publish_workflows"')) {
      return script.facts === null ? [] : [{ ...FACTS, ...script.facts }];
    }
    if (has(statement, 'from "organizations"')) return [{ ...PLAN, nodes: 1, ...script.plan }];
    if (has(statement, 'insert into "publish_log"')) {
      return script.logged === null ? [] : [logRow(script.logged)];
    }
    if (has(statement, 'update "nodes"')) return [{}];
    if (has(statement, 'from "node_versions" as "v"')) return [{ id: VERSION }];
    if (has(statement, 'from "publish_approvals"')) return [{ approved_at: AT }];
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

const build = (respond: Responder, over: Partial<EngineDeps> = {}) => {
  const store = scriptedStore(respond);
  const engine = createEngine({
    store: store.store,
    parse: { print: () => Promise.reject(new Error('publish never parses')) },
    parsePolicy: {
      version: 3,
      components: [],
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https'],
    },
    flags: { evaluate: () => Promise.resolve({ value: true }) },
    ...over,
  });
  return { engine, ...store };
};

const WRITES = [
  'insert into "publish_log"',
  'update "published_versions"',
  'insert into app.published_versions',
  'insert into app.published_filter_rows',
  'update "nodes"',
];

const wrote = (statements: readonly Statement[]) =>
  statements.filter((statement) => WRITES.some((write) => has(statement, write)));

describe('publish', () => {
  it('locks, reads, checks, then writes the log, both copies and the node in one transaction', async () => {
    const { engine, statements, ends } = build(scripted());
    const done = await engine.publish(input());
    expect(done).toEqual({
      ok: true,
      value: {
        nodeId: NODE,
        versionId: HEAD,
        previousVersionId: null,
        renderPolicyVersion: 3,
        publishedAt: AT,
      },
    });
    expect(ends).toEqual(['commit']);
    expect(wrote(statements).map((s) => WRITES.find((w) => has(s, w)))).toEqual(WRITES);
    const log = statements.find((s) => has(s, 'insert into "publish_log"'));
    expect(log?.parameters).toEqual(
      expect.arrayContaining([NODE, HEAD, 'user', USER, 'publish-1', 3]),
    );
    const node = statements.find((s) => has(s, 'update "nodes"'));
    expect(node?.parameters).toEqual(expect.arrayContaining(['published', HEAD]));
  });

  it('copies the content inside the database and stamps the render policy version', async () => {
    const { engine, statements } = build(scripted());
    await engine.publish(input());
    const copy = statements.find((s) => has(s, 'insert into app.published_versions'));
    expect(copy?.sql).toContain('from app.node_versions v');
    expect(copy?.sql).toContain('on conflict on constraint published_versions_version_key');
    expect(copy?.parameters).toEqual(
      expect.arrayContaining([TYPE, 3, tenant.organizationId, tenant.projectId, NODE, HEAD]),
    );
  });

  it('can publish an earlier version while the head moves on, and names what it replaced', async () => {
    const { engine } = build(
      scripted({ logged: { version_id: EARLIER, previous_version_id: HEAD } }),
    );
    const done = await engine.publish(input({ versionId: EARLIER }));
    expect(done.ok && done.value).toMatchObject({ versionId: EARLIER, previousVersionId: HEAD });
  });

  it('writes the version slot values to the published filter row, every column', async () => {
    const respond = scripted({
      facts: {
        fields: { [FIELD]: 'beta' },
        filter_slots: { [FIELD]: { column: 't2', state: 'ready' } },
      },
    });
    const { engine, statements } = build(respond);
    expect((await engine.publish(input())).ok).toBe(true);
    const filter = statements.find((s) => has(s, 'insert into app.published_filter_rows'));
    expect(filter?.parameters).toContain('beta');
    expect(filter?.sql).toContain('"d2" = "excluded"."d2"');
    expect(filter?.sql).toMatch(/::text\[\]/);
    expect(filter?.sql).toMatch(/::bigint/);
    expect(filter?.sql).toMatch(/::timestamptz/);
  });

  it('refuses bad input before any statement', async () => {
    const { engine, statements } = build(scripted());
    const done = await engine.publish({ ...input(), idempotencyKey: '' });
    expect(done.ok || done.error).toMatchObject({
      code: 'publish.validation_failed',
      retryable: false,
      issues: [{ path: 'idempotencyKey' }],
    });
    const badGit = await engine.publish(input({ actor: { ...GIT, installationId: 'acme' } }));
    expect(badGit.ok || badGit.error.code).toBe('publish.validation_failed');
    expect(statements).toEqual([]);
  });

  it('refuses everything while engine writes are off, before any statement', async () => {
    const off = { evaluate: () => Promise.resolve({ value: false }) };
    const { engine, statements } = build(scripted(), { flags: off });
    const done = await engine.publish(input());
    expect(done.ok || done.error.code).toBe('publish.forbidden');
    expect(statements).toEqual([]);
  });

  it.each<[string, Script]>([
    ['a missing or deleted node', { node: null }],
    ['a version of another node or tenant', { facts: null }],
  ])('answers not_found for %s and writes nothing', async (_name, script) => {
    const { engine, statements, ends } = build(scripted(script));
    const done = await engine.publish(input());
    expect(done.ok || done.error.code).toBe('publish.not_found');
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it.each<[string, Actor, Partial<Facts>, string]>([
    ['a viewer', VIEWER, {}, 'publish.forbidden'],
    [
      'an editor where review is required',
      EDITOR,
      { approval_required: true },
      'publish.approval_required',
    ],
    [
      'a key on AI content',
      DOCS_KEY,
      { origin: 'ai', api_keys_publish: true },
      'publish.human_required',
    ],
    [
      'a key where review is required',
      DOCS_KEY,
      { approval_required: true, api_keys_publish: true },
      'publish.human_required',
    ],
    ['a key the project does not allow', DOCS_KEY, {}, 'publish.forbidden'],
    ['a push the project does not allow', GIT, {}, 'publish.forbidden'],
    ['a system job', { kind: 'system', job: 'staleness' }, {}, 'publish.forbidden'],
    [
      'a system job on AI content',
      { kind: 'system', job: 'staleness' },
      { origin: 'ai' },
      'publish.human_required',
    ],
  ])('refuses %s and writes nothing', async (_name, actor, facts, code) => {
    const { engine, statements, ends } = build(scripted({ facts }));
    const done = await engine.publish(input({ actor }));
    expect(done.ok || done.error).toEqual({ code, retryable: false, issues: [] });
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['rollback']);
  });

  it.each<[string, Actor, Partial<Facts>]>([
    ['an approved version by an editor', EDITOR, { approval_required: true, approved: true }],
    ['a scoped key the project allows', DOCS_KEY, { api_keys_publish: true }],
    ['a push the project allows', GIT, { git_publish: true }],
    ['AI content by an admin', ADMIN, { origin: 'ai' }],
  ])('publishes %s', async (_name, actor, facts) => {
    const { engine, ends } = build(scripted({ facts }));
    const done = await engine.publish(input({ actor }));
    expect(done.ok).toBe(true);
    expect(ends).toEqual(['commit']);
  });

  it('logs a push by its installation and never the author address', async () => {
    const { lines, logger } = capture();
    const { engine } = build(scripted({ facts: { git_publish: true } }), { logger });
    await engine.publish(input({ actor: GIT }));
    const line = lines.find((l) => l.event === 'engine.publish');
    expect(line?.fields).toMatchObject({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: NODE,
      version_id: HEAD,
      actor_kind: 'git',
      actor_id: '42',
      previous_version_id: 'none',
      render_policy_version: 3,
    });
    expect(JSON.stringify(lines)).not.toContain('dev@example.com');
  });

  it('logs a refusal with its code', async () => {
    const { lines, logger } = capture();
    const { engine } = build(scripted(), { logger });
    await engine.publish(input({ actor: VIEWER }));
    expect(lines.find((l) => l.event === 'engine.publish.refused')?.fields).toMatchObject({
      code: 'publish.forbidden',
      actor_kind: 'user',
    });
  });

  it('answers version_conflict when the head moved, after the gate', async () => {
    const { engine, statements } = build(scripted());
    const moved = await engine.publish(input({ expectedHeadVersionId: EARLIER }));
    expect(moved.ok || moved.error.code).toBe('publish.version_conflict');
    expect(wrote(statements)).toEqual([]);
    // A caller the gate refuses learns nothing about the head.
    const viewer = await engine.publish(
      input({ expectedHeadVersionId: EARLIER, actor: VIEWER, idempotencyKey: 'other' }),
    );
    expect(viewer.ok || viewer.error.code).toBe('publish.forbidden');
  });

  it('answers read_only over a downgraded plan and writes nothing', async () => {
    const plan = { organization_read_only: AT };
    const { engine, statements } = build(scripted({ plan }));
    const done = await engine.publish(input());
    expect(done.ok || done.error.code).toBe('publish.read_only');
    expect(wrote(statements)).toEqual([]);
  });

  it('gives a replay the first receipt and writes nothing', async () => {
    const prior = logRow({ previous_version_id: EARLIER });
    const { engine, statements, ends } = build(scripted({ prior }));
    const done = await engine.publish(input());
    expect(done.ok && done.value).toEqual({
      nodeId: NODE,
      versionId: HEAD,
      previousVersionId: EARLIER,
      renderPolicyVersion: 3,
      publishedAt: AT,
    });
    expect(wrote(statements)).toEqual([]);
    expect(ends).toEqual(['commit']);
  });

  it.each<[string, Partial<PublishInput>]>([
    ['another version', { versionId: EARLIER }],
    ['another node', { nodeId: idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8011') }],
    ['another expected head', { expectedHeadVersionId: EARLIER }],
    ['another person', { actor: { ...EDITOR, userId: idOf('usr', MACHINE) } }],
    ['another kind of actor', { actor: DOCS_KEY }],
  ])(
    'answers idempotency_conflict for the same key with %s and changes nothing',
    async (_n, over) => {
      const { engine, statements, ends } = build(scripted({ prior: logRow() }));
      const done = await engine.publish(input(over));
      expect(done.ok || done.error.code).toBe('publish.idempotency_conflict');
      expect(wrote(statements)).toEqual([]);
      expect(ends).toEqual(['rollback']);
    },
  );

  it('treats a key taken by another node mid flight as a conflict and keeps none of it', async () => {
    const { engine, statements, ends } = build(scripted({ logged: null }));
    const done = await engine.publish(input());
    expect(done.ok || done.error.code).toBe('publish.idempotency_conflict');
    expect(wrote(statements).map((s) => WRITES.find((w) => has(s, w)))).toEqual([WRITES[0]]);
    expect(ends).toEqual(['rollback']);
  });

  it('answers a busy database as retryable and rolls back', async () => {
    const fail = (s: Statement) =>
      has(s, 'insert into app.published_filter_rows') ? new DbError('DB_TIMEOUT', 'x') : null;
    const { engine, ends } = build(scripted({ fail }));
    const done = await engine.publish(input());
    expect(done.ok || done.error).toEqual({
      code: 'publish.unavailable',
      retryable: true,
      issues: [],
    });
    expect(ends).toEqual(['rollback']);
  });

  it('throws anything else after the rollback', async () => {
    const fail = (s: Statement) =>
      has(s, 'update "published_versions"') ? new DbError('DB_RLS_VIOLATION', 'x') : null;
    const { engine, ends } = build(scripted({ fail }));
    await expect(engine.publish(input())).rejects.toThrow('x');
    expect(ends).toEqual(['rollback']);
  });

  it('names every code it can answer in the exported list', () => {
    expect(PUBLISH_ERROR_CODES).toEqual([
      'publish.not_found',
      'publish.forbidden',
      'publish.approval_required',
      'publish.human_required',
      'publish.version_conflict',
      'publish.validation_failed',
      'publish.idempotency_conflict',
      'publish.read_only',
      'publish.unavailable',
    ]);
  });
});

describe('approve', () => {
  const approval = (over: Partial<ApproveInput> = {}): ApproveInput => ({
    tenant,
    nodeId: NODE,
    versionId: HEAD,
    actor: ADMIN,
    ...over,
  });

  it('records an admin approval and answers with its time', async () => {
    const { engine, statements, ends } = build(scripted());
    const done = await engine.approve(approval());
    expect(done).toEqual({
      ok: true,
      value: { nodeId: NODE, versionId: HEAD, approverId: USER, approvedAt: AT },
    });
    const insert = statements.find((s) => has(s, 'insert into "publish_approvals"'));
    expect(insert?.sql).toContain('on conflict');
    expect(insert?.parameters).toEqual(expect.arrayContaining([NODE, HEAD, USER]));
    expect(ends).toEqual(['commit']);
  });

  it.each<[string, Actor, string]>([
    ['an editor', EDITOR, 'publish.forbidden'],
    ['a key', DOCS_KEY, 'publish.human_required'],
    ['a push', GIT, 'publish.human_required'],
    ['a system job', { kind: 'system', job: 'staleness' }, 'publish.human_required'],
  ])('refuses %s before any statement and logs it', async (_name, actor, code) => {
    const { lines, logger } = capture();
    const { engine, statements } = build(scripted(), { logger });
    const done = await engine.approve(approval({ actor }));
    expect(done.ok || done.error.code).toBe(code);
    expect(statements).toEqual([]);
    expect(lines.find((l) => l.event === 'engine.approve.refused')?.fields).toMatchObject({
      code,
    });
  });

  it('refuses bad input and a writes flag that is off', async () => {
    const { engine } = build(scripted());
    const bad = await engine.approve({ ...approval(), versionId: 'nope' as never });
    expect(bad.ok || bad.error.code).toBe('publish.validation_failed');
    const off = { evaluate: () => Promise.resolve({ value: false }) };
    const closed = build(scripted(), { flags: off });
    const done = await closed.engine.approve(approval());
    expect(done.ok || done.error.code).toBe('publish.forbidden');
    expect(closed.statements).toEqual([]);
  });

  it('answers not_found for a version it cannot see', async () => {
    const respond: Responder = (s) => (has(s, 'from "node_versions" as "v"') ? [] : scripted()(s));
    const { engine, statements } = build(respond);
    const done = await engine.approve(approval());
    expect(done.ok || done.error.code).toBe('publish.not_found');
    expect(statements.some((s) => has(s, 'insert into "publish_approvals"'))).toBe(false);
  });
});
