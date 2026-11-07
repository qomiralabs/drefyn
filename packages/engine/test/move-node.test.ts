import { DbError } from '@drefyn/db';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createEngine, type EngineLogger, type MovingActor } from '../src/index.ts';
import { MAX_ORDER_KEY_CHARS } from '../src/order-key.ts';
import { MAX_SUBTREE_ROWS, MAX_TREE_LEVELS, TREE_LOCK_WAIT_MS } from '../src/tree.ts';
import { scriptedStore, type Responder, type Statement } from './support/scripted-store.ts';

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const NODE = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8003');
const PARENT = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8004');
const ANCHOR = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8005');
const NEXT = idOf('nod', '01890a5d-ac96-774b-bcce-b302099a8006');
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8007';

const has = (statement: Statement, text: string) => statement.sql.includes(text);

const PLAN = { plan_tier: 'self_hosted', organization_read_only: null, project_read_only: null };

// What one walk answers. Never a list: the point is that no chain reaches Node.
const climb = (levels: number, over: Partial<{ gone: boolean; holds: boolean }> = {}) => ({
  levels,
  gone: false,
  holds: false,
  ...over,
});

interface Tree {
  readonly parent?: ReturnType<typeof climb>;
  readonly node?: ReturnType<typeof climb>;
  readonly below?: { readonly height: number; readonly rows: number };
  readonly anchor?: readonly Record<string, unknown>[];
  readonly next?: readonly Record<string, unknown>[];
}

const walkOf = (statement: Statement) => {
  if (has(statement, 'with recursive chain')) {
    return statement.parameters[2] === PARENT ? 'parent' : 'node';
  }
  return has(statement, 'with recursive below') ? 'below' : null;
};

const treeOf =
  ({
    parent = climb(1),
    node = climb(1),
    below = { height: 1, rows: 1 },
    anchor = [{ id: ANCHOR, order_key: 'a0' }],
    next = [{ id: NEXT, order_key: 'a2' }],
  }: Tree = {}): Responder =>
  (statement) => {
    if (has(statement, 'pg_advisory_xact_lock')) return [{}];
    if (has(statement, 'for update')) {
      return [{ id: NODE, family: 'docs_page', type_id: TYPE, head_version_id: null }];
    }
    if (has(statement, '"organizations"')) return [PLAN];
    const walk = walkOf(statement);
    if (walk === 'parent') return [parent];
    if (walk === 'node') return [node];
    if (walk === 'below') return [below];
    if (has(statement, 'update')) return [];
    return has(statement, 'order by') ? [...next] : [...anchor];
  };

const build = (respond: Responder, on = true) => {
  const scripted = scriptedStore(respond);
  const info = vi.fn<EngineLogger['info']>();
  const logger: EngineLogger = { info, warn: vi.fn() };
  const engine = createEngine({
    store: scripted.store,
    parse: { print: () => Promise.reject(new Error('a move prints nothing')) },
    parsePolicy: {
      version: 1,
      components: [],
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https'],
    },
    flags: { evaluate: () => Promise.resolve({ value: on }) },
    logger,
  });
  return { ...scripted, engine, info };
};

const ACTOR = { kind: 'system', job: 'test' } as const;
const move = { tenant, nodeId: NODE, parentId: PARENT, afterId: ANCHOR, actor: ACTOR };

describe('moveNode', () => {
  it('takes the lock first and alone, then writes one update with both tenant ids', async () => {
    const { engine, statements, ends } = build(treeOf());
    expect(await engine.moveNode(move)).toEqual({ ok: true, value: undefined });

    expect(statements[0]?.sql).toMatch(/^set local lock_timeout/);
    expect(statements[1]?.sql).toMatch(/^select pg_advisory_xact_lock/);
    expect(statements[1]?.sql).not.toMatch(/from/);
    expect(statements[1]?.parameters.join()).toContain(tenant.organizationId);
    expect(statements[1]?.parameters.join()).toContain(tenant.projectId);

    const updates = statements.filter((statement) => has(statement, 'update "nodes"'));
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update?.parameters).toEqual(
      expect.arrayContaining([PARENT, 'a1', tenant.organizationId, tenant.projectId, NODE]),
    );
    expect(ends).toEqual(['commit']);
  });

  it('names both tenant ids in every statement after the lock', async () => {
    const { engine, statements } = build(treeOf());
    await engine.moveNode(move);
    for (const statement of statements.slice(2)) {
      expect(statement.parameters).toEqual(
        expect.arrayContaining([tenant.organizationId, tenant.projectId]),
      );
    }
  });

  it('refuses when writes are off, with no statement', async () => {
    const { engine, statements } = build(treeOf(), false);
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: { code: 'engine.forbidden' },
    });
    expect(statements).toEqual([]);
  });

  it.each([
    ['an id that is no uuid', { ...move, nodeId: 'nope' }, 'nodeId'],
    ['an unknown key', { ...move, orderKey: 'a1' }, ''],
    ['a node after itself', { ...move, afterId: NODE }, 'afterId'],
    ['a missing parent field', { tenant, nodeId: NODE, afterId: null, actor: ACTOR }, 'parentId'],
    ['a missing actor', { tenant, nodeId: NODE, parentId: null, afterId: null }, 'actor'],
  ])('refuses %s before any statement', async (_name, input, path) => {
    const { engine, statements } = build(treeOf());
    const moved = await engine.moveNode(input as typeof move);
    expect(moved).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    if (!moved.ok) expect(moved.error.issues.map((issue) => issue.path)).toContain(path);
    expect(statements).toEqual([]);
  });

  it('walks up from the node alone for a move to the root', async () => {
    const { engine, statements } = build(treeOf());
    expect(await engine.moveNode({ ...move, parentId: null })).toMatchObject({ ok: true });
    expect(statements.map(walkOf).filter((walk) => walk !== null)).toEqual(['node']);
    const update = statements.find((statement) => has(statement, 'update "nodes"'));
    expect(update?.parameters).toEqual(expect.arrayContaining([null]));
  });

  it.each([
    ['a live parent', PARENT],
    ['the root', null],
  ])('reads a node inside a deleted branch as not found, moving to %s', async (_name, parentId) => {
    const { engine, statements } = build(treeOf({ node: climb(3, { gone: true }) }));
    expect(await engine.moveNode({ ...move, parentId, afterId: null })).toEqual({
      ok: false,
      error: { code: 'engine.not_found', retryable: false, issues: [] },
    });
    expect(statements.some((statement) => has(statement, 'update "nodes"'))).toBe(false);
    // Before the plan is read, so it answers the same in a read only project.
    expect(statements.some((statement) => has(statement, '"organizations"'))).toBe(false);
  });

  it('puts a node first with no anchor, and last with nothing after the anchor', async () => {
    const first = build(treeOf());
    expect(await first.engine.moveNode({ ...move, afterId: null })).toMatchObject({ ok: true });
    const firstUpdate = first.statements.find((statement) => has(statement, 'update "nodes"'));
    expect(firstUpdate?.parameters).toEqual(expect.arrayContaining(['a1']));

    const last = build(treeOf({ next: [] }));
    expect(await last.engine.moveNode(move)).toMatchObject({ ok: true });
    const lastUpdate = last.statements.find((statement) => has(statement, 'update "nodes"'));
    expect(lastUpdate?.parameters).toEqual(expect.arrayContaining(['a1']));
  });

  it.each([
    ['the node itself as parent', { parent: climb(1, { holds: true }) }],
    ['a descendant as parent', { parent: climb(2, { holds: true }) }],
  ])('refuses %s and writes nothing', async (_name, tree) => {
    const { engine, statements, ends } = build(treeOf(tree));
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'parentId', code: 'engine.cycle' }],
      },
    });
    expect(statements.some((statement) => has(statement, 'update "nodes"'))).toBe(false);
    expect(ends).toEqual(['rollback']);
  });

  it.each([
    ['a parent that is gone', { parent: climb(0) }],
    ['a deleted parent', { parent: climb(1, { gone: true }) }],
    ['a deleted ancestor', { parent: climb(2, { gone: true }) }],
    ['an anchor that is not a child of the parent', { anchor: [] }],
  ])('answers not found for %s, with nothing naming which id', async (_name, tree) => {
    const { engine, ends } = build(treeOf(tree));
    expect(await engine.moveNode(move)).toEqual({
      ok: false,
      error: { code: 'engine.not_found', retryable: false, issues: [] },
    });
    expect(ends).toEqual(['rollback']);
  });

  describe('depth', () => {
    const tooDeep = {
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'parentId', code: 'engine.tree_too_deep' }],
      },
    };
    const wrote = (statements: readonly Statement[]) =>
      statements.some((statement) => has(statement, 'update "nodes"'));

    it('refuses a parent with no level left under it', async () => {
      const { engine, statements, ends } = build(
        treeOf({ parent: climb(MAX_TREE_LEVELS), node: climb(1) }),
      );
      expect(await engine.moveNode(move)).toMatchObject(tooDeep);
      expect(wrote(statements)).toBe(false);
      expect(ends).toEqual(['rollback']);
    });

    it('counts the levels of the moved subtree', async () => {
      const fits = build(treeOf({ parent: climb(60), below: { height: 4, rows: 9 } }));
      expect(await fits.engine.moveNode(move)).toMatchObject({ ok: true });

      const over = build(treeOf({ parent: climb(60), below: { height: 5, rows: 9 } }));
      expect(await over.engine.moveNode(move)).toMatchObject(tooDeep);
      expect(wrote(over.statements)).toBe(false);
    });

    it('stops reading a subtree one level past the room it has, and at a row budget', async () => {
      const { engine, statements } = build(treeOf({ parent: climb(60) }));
      await engine.moveNode(move);
      const walk = statements.find((statement) => walkOf(statement) === 'below');
      expect(walk?.parameters).toEqual(expect.arrayContaining([4, MAX_SUBTREE_ROWS]));
    });

    it('stops a climb one level past the cap, so a deep chain costs what a legal one does', async () => {
      const { engine, statements } = build(treeOf());
      await engine.moveNode(move);
      const walks = statements.filter((statement) => has(statement, 'with recursive chain'));
      expect(walks.length).toBeGreaterThan(0);
      for (const walk of walks) expect(walk.parameters).toContain(MAX_TREE_LEVELS);
    });

    it('refuses a subtree too large to measure rather than guess', async () => {
      const { engine, statements } = build(
        treeOf({ parent: climb(3), below: { height: 2, rows: MAX_SUBTREE_ROWS } }),
      );
      expect(await engine.moveNode(move)).toMatchObject({
        ok: false,
        error: {
          code: 'engine.too_large',
          issues: [{ path: 'nodeId', code: 'engine.too_large' }],
        },
      });
      expect(wrote(statements)).toBe(false);
    });

    it.each([
      ['to the same level', { parent: climb(4), node: climb(5) }],
      ['to a shallower level', { parent: climb(2), node: climb(5) }],
      ['up to an ancestor', { parent: climb(9), node: climb(9, { holds: true }) }],
    ])('does not read the subtree for a move %s', async (_name, tree) => {
      const { engine, statements } = build(treeOf(tree));
      expect(await engine.moveNode(move)).toMatchObject({ ok: true });
      expect(statements.some((statement) => walkOf(statement) === 'below')).toBe(false);
    });

    it('lets a node already past the cap reorder under its own parent', async () => {
      const deep = MAX_TREE_LEVELS + 1;
      const { engine } = build(treeOf({ parent: climb(deep), node: climb(deep, { holds: true }) }));
      expect(await engine.moveNode(move)).toMatchObject({ ok: true });
    });

    it('checks no depth for a move to the root, the way out of a tree that is too deep', async () => {
      const { engine, statements } = build(
        treeOf({ anchor: [], next: [], node: climb(MAX_TREE_LEVELS + 1) }),
      );
      expect(await engine.moveNode({ ...move, parentId: null, afterId: null })).toMatchObject({
        ok: true,
      });
      expect(statements.map(walkOf).filter((walk) => walk !== null)).toEqual(['node']);
    });
  });

  describe('the queue', () => {
    it('sets a lock wait of its own before it takes the lock', async () => {
      const { engine, statements } = build(treeOf());
      await engine.moveNode(move);
      const limit = statements.findIndex((statement) =>
        has(statement, `set local lock_timeout = ${String(TREE_LOCK_WAIT_MS)}`),
      );
      const lock = statements.findIndex((statement) => has(statement, 'pg_advisory_xact_lock'));
      expect(limit).toBeGreaterThanOrEqual(0);
      expect(limit).toBeLessThan(lock);
    });

    it('waits well under the two seconds a pooled connection may be waited for', () => {
      expect(TREE_LOCK_WAIT_MS).toBeLessThanOrEqual(1000);
    });
  });

  it('refuses a read only project', async () => {
    const respond = treeOf();
    const { engine } = build((statement) =>
      has(statement, '"organizations"')
        ? [{ ...PLAN, project_read_only: new Date(0) }]
        : respond(statement),
    );
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: { code: 'engine.read_only' },
    });
  });

  it('refuses a tie rather than landing somewhere else', async () => {
    const { engine } = build(treeOf({ next: [{ id: NEXT, order_key: 'a0' }] }));
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'afterId', code: 'engine.order_key_no_room' }],
      },
    });
  });

  it('refuses a key past the cap rather than let the index refuse it', async () => {
    const long = `a0${'V'.repeat(MAX_ORDER_KEY_CHARS)}1`;
    const { engine } = build(
      treeOf({
        anchor: [{ id: ANCHOR, order_key: long }],
        next: [{ id: NEXT, order_key: `${long}1` }],
      }),
    );
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: { code: 'engine.too_large', issues: [{ path: 'afterId', code: 'engine.too_large' }] },
    });
  });

  it('turns a timeout into the one retryable answer', async () => {
    const { engine } = build(() => {
      throw new DbError('DB_TIMEOUT', 'busy');
    });
    expect(await engine.moveNode(move)).toMatchObject({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true },
    });
  });

  it('logs ids and the outcome, and never a key', async () => {
    const { engine, info } = build(treeOf());
    await engine.moveNode(move);
    expect(info).toHaveBeenCalledWith(
      'engine.move',
      expect.objectContaining({
        organization_id: tenant.organizationId,
        project_id: tenant.projectId,
        node_id: NODE,
        parent_id: PARENT,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('"a1"');
  });

  it.each([
    [
      'a person',
      { kind: 'user', userId: idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8008'), roles: ['a'] },
      'user',
      idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8008'),
    ],
    [
      'an API key',
      { kind: 'api_key', keyId: '01890a5d-ac96-774b-bcce-b302099a8009', scopes: ['b'] },
      'api_key',
      '01890a5d-ac96-774b-bcce-b302099a8009',
    ],
    [
      'a git sync',
      {
        kind: 'git',
        installationId: '12345678',
        commitSha: 'a'.repeat(40),
        authorEmail: 'author@example.com',
      },
      'git',
      '12345678',
    ],
    ['a job', { kind: 'system', job: 'bench' }, 'system', 'bench'],
  ] as const)('records who moved it: %s', async (_name, actor, kind, id) => {
    const { engine, info } = build(treeOf());
    expect(await engine.moveNode({ ...move, actor })).toMatchObject({ ok: true });
    expect(info).toHaveBeenCalledWith(
      'engine.move',
      expect.objectContaining({ actor_kind: kind, actor_id: id }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('author@example.com');
  });

  it.each([
    ['a job named after a person', { kind: 'system', job: 'sync for alice@example.com' }, 'job'],
    ['a job that forges a log line', { kind: 'system', job: 'import\nengine.move ok' }, 'job'],
    ['a job shaped like a host name', { kind: 'system', job: 'alice.example.com' }, 'job'],
    ['a job shaped like a user name', { kind: 'system', job: 'jane_doe' }, 'job'],
    ['a job with a name after a colon', { kind: 'system', job: 'export:john-smith' }, 'job'],
    [
      'a key id that is not an id',
      { kind: 'api_key', keyId: 'alice@example.com', scopes: [] },
      'keyId',
    ],
    [
      'an installation that is not a number',
      {
        kind: 'git',
        installationId: 'alice@example.com',
        commitSha: 'a'.repeat(40),
        authorEmail: 'author@example.com',
      },
      'installationId',
    ],
  ] as const)('refuses %s before anything runs or is logged', async (_name, actor, field) => {
    const { engine, info, statements } = build(treeOf());
    // What a caller outside TypeScript could send; the type alone would not stop it.
    const result = await engine.moveNode({ ...move, actor: actor as unknown as MovingActor });
    expect(result).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    expect(result.ok ? [] : result.error.issues.map((issue) => issue.path)).toContain(
      `actor.${field}`,
    );
    expect(statements).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('records who tried, when a move is refused', async () => {
    const { engine, info } = build(treeOf({ parent: climb(0) }));
    await engine.moveNode(move);
    expect(info).toHaveBeenCalledWith(
      'engine.move.refused',
      expect.objectContaining({ actor_kind: 'system', actor_id: 'test' }),
    );
  });

  it('logs the refusal with its code', async () => {
    const { engine, info } = build(treeOf({ parent: climb(0) }));
    await engine.moveNode({ ...move, parentId: PARENT });
    expect(info).toHaveBeenCalledWith(
      'engine.move.refused',
      expect.objectContaining({ code: 'engine.not_found', parent_id: PARENT }),
    );
  });
});

describe('createNode with no key', () => {
  const create = { tenant, family: 'docs_page', typeId: TYPE } as const;
  const respond =
    (last: readonly Record<string, unknown>[], parent = climb(1)): Responder =>
    (statement) => {
      if (has(statement, '"content_types"')) return [{ family: 'docs_page' }];
      if (has(statement, '"organizations"')) return [PLAN];
      if (has(statement, 'with recursive chain')) return [parent];
      if (has(statement, 'insert into "organization_node_counts"')) return [{ nodes: 1 }];
      if (has(statement, 'insert into "nodes"')) return [{ id: NODE }];
      if (has(statement, 'order by "order_key" desc')) return [...last];
      if (has(statement, 'from "nodes" where')) return [{ id: PARENT }];
      return [];
    };
  const insertOf = (statements: readonly Statement[]) =>
    statements.find((statement) => has(statement, 'insert into "nodes"'));

  it('lands after the last sibling, under the lock', async () => {
    const { engine, statements } = build(respond([{ id: ANCHOR, order_key: 'a5' }]));
    expect(await engine.createNode(create)).toMatchObject({ ok: true });
    expect(insertOf(statements)?.parameters).toContain('a6');
    const lock = statements.findIndex((statement) => has(statement, 'pg_advisory_xact_lock'));
    const read = statements.findIndex((statement) => has(statement, 'order by "order_key" desc'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(read);
  });

  it('starts at a0 with no siblings', async () => {
    const { engine, statements } = build(respond([]));
    expect(await engine.createNode(create)).toMatchObject({ ok: true });
    expect(insertOf(statements)?.parameters).toContain('a0');
  });

  it('takes no lock for a key the caller chose', async () => {
    const { engine, statements } = build(respond([]));
    expect(await engine.createNode({ ...create, orderKey: 'a7' })).toMatchObject({ ok: true });
    expect(insertOf(statements)?.parameters).toContain('a7');
    expect(statements.some((statement) => has(statement, 'pg_advisory_xact_lock'))).toBe(false);
  });

  it.each([
    ['no key', {}],
    ['a key the caller chose', { orderKey: 'a7' }],
  ])('checks a parent under the lock with %s', async (_name, keyed) => {
    const { engine, statements } = build(respond([]));
    expect(await engine.createNode({ ...create, ...keyed, parentId: PARENT })).toMatchObject({
      ok: true,
    });
    const lock = statements.findIndex((statement) => has(statement, 'pg_advisory_xact_lock'));
    const walk = statements.findIndex((statement) => has(statement, 'with recursive chain'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(walk);
  });

  it('takes the last level and refuses the one after it', async () => {
    const fits = build(respond([], climb(MAX_TREE_LEVELS - 1)));
    expect(await fits.engine.createNode({ ...create, parentId: PARENT })).toMatchObject({
      ok: true,
    });

    const over = build(respond([], climb(MAX_TREE_LEVELS)));
    expect(await over.engine.createNode({ ...create, parentId: PARENT })).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'parentId', code: 'engine.tree_too_deep' }],
      },
    });
    expect(insertOf(over.statements)).toBeUndefined();
    expect(over.ends).toEqual(['rollback']);
  });

  it.each([
    ['inside a deleted branch', climb(3, { gone: true }), {}],
    ['inside a deleted branch, with a key', climb(3, { gone: true }), { orderKey: 'a7' }],
    ['gone before the lock was taken', climb(0), {}],
  ])('answers not found for a parent %s, with nothing written', async (_name, parent, keyed) => {
    const { engine, statements, ends } = build(respond([], parent));
    expect(await engine.createNode({ ...create, ...keyed, parentId: PARENT })).toMatchObject({
      ok: false,
      error: { code: 'engine.not_found' },
    });
    expect(insertOf(statements)).toBeUndefined();
    expect(ends).toEqual(['rollback']);
  });

  it.each(['a', 'a00', '!', `a${'1'.repeat(64)}`])('refuses %j as a key', async (orderKey) => {
    const { engine, statements } = build(respond([]));
    expect(await engine.createNode({ ...create, orderKey })).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
    expect(statements).toEqual([]);
  });

  it('refuses when the last sibling has a key nothing can follow', async () => {
    const { engine } = build(respond([{ id: ANCHOR, order_key: 'not a key' }]));
    expect(await engine.createNode(create)).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'orderKey', code: 'engine.order_key_no_room' }],
      },
    });
  });
});
