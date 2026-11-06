import { createHash, randomUUID } from 'node:crypto';
import { closeDatabase, type Database } from '@drefyn/db';
import type { ParseClient } from '@drefyn/mdx/client';
import { idOf } from '@drefyn/tenancy';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Engine, EngineLogger, EngineResult, NodeId, VersionId } from '../src/index.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  key,
  newNode,
  openDatabase,
  save,
  seed,
  tree,
  versionCount,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';

let db: Database;
let built: Built;
let engine: Engine;
let parse: ParseClient;
let home: Seeded;

const input = async (
  nodeId: NodeId,
  expected: VersionId | null,
  text: string,
  seeded: Seeded = home,
) => ({
  tenant: seeded.tenant,
  nodeId,
  expectedHeadVersionId: expected,
  content: await tree(parse, home, text),
  origin: 'human' as const,
  actor: ACTOR,
  idempotencyKey: key(),
});

const BUSY_OR_LOST = ['engine.version_conflict', 'engine.unavailable'];

const codeOf = (result: EngineResult<unknown>) => (result.ok ? 'ok' : result.error.code);

describeWithStack('saveDraft against Postgres', () => {
  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine, parse } = built);
    home = await seed();
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  it('stores a first version as the head', async () => {
    const node = await newNode(engine, home);
    const saved = await save(built, home, node, null, '# Title\n\nBody\n');
    expect(saved.seq).toBe(1);
    const head = await engine.getHead(home.tenant, node);
    expect(head).toMatchObject({
      ok: true,
      value: { nodeId: node, versionId: saved.versionId, seq: 1, astVersion: 1 },
    });
    if (head.ok) expect(head.value.content).toEqual(await tree(parse, home, '# Title\n\nBody\n'));
  });

  it('gets an empty head for a node with no version yet', async () => {
    const node = await newNode(engine, home);
    expect(await engine.getHead(home.tenant, node)).toMatchObject({
      ok: true,
      value: { nodeId: node, versionId: null, seq: null, content: null },
    });
  });

  it('refuses a first save that claims a head, and a later one that claims none', async () => {
    const node = await newNode(engine, home);
    const ghost = idOf('ver', randomUUID());
    expect(codeOf(await engine.saveDraft(await input(node, ghost, 'a\n')))).toBe(
      'engine.version_conflict',
    );
    await save(built, home, node, null, 'a\n');
    expect(codeOf(await engine.saveDraft(await input(node, null, 'b\n')))).toBe(
      'engine.version_conflict',
    );
    expect(await versionCount(node)).toBe(1);
  });

  it('never picks a client id', async () => {
    const chosen = randomUUID();
    const made = await engine.createNode({
      tenant: home.tenant,
      family: 'docs_page',
      typeId: home.typeId,
      id: chosen,
    } as never);
    expect(codeOf(made)).toBe('engine.validation_failed');
    expect(await admin(`select count(*) from app.nodes where id = '${chosen}';`)).toBe('0');
  });

  it('the second of two racing saves conflicts and the first stays', async () => {
    const node = await newNode(engine, home);
    const first = await save(built, home, node, null, 'base\n');
    const results = await Promise.all(
      ['left\n', 'right\n'].map(async (text) =>
        engine.saveDraft(await input(node, first.versionId, text)),
      ),
    );
    expect(results.map(codeOf).sort()).toEqual(['engine.version_conflict', 'ok']);
    expect(await versionCount(node)).toBe(2);
    const winner = results.find((result) => result.ok);
    const head = await engine.getHead(home.tenant, node);
    expect(head.ok && head.value.versionId).toBe(winner?.ok === true && winner.value.versionId);
  });

  it('keeps both once the loser retries on the new head', async () => {
    const node = await newNode(engine, home);
    const first = await save(built, home, node, null, 'base\n');
    const second = await save(built, home, node, first.versionId, 'left\n');
    expect(codeOf(await engine.saveDraft(await input(node, first.versionId, 'right\n')))).toBe(
      'engine.version_conflict',
    );
    const third = await save(built, home, node, second.versionId, 'right\n');
    expect(third.seq).toBe(3);
    const listed = await engine.listVersions(home.tenant, node, {});
    expect(listed.ok && listed.value.items.map((item) => item.seq)).toEqual([3, 2, 1]);
  });

  it('lets one of twenty racing saves through, with no gap', async () => {
    const node = await newNode(engine, home);
    const first = await save(built, home, node, null, 'base\n');
    const drafts = [];
    for (let index = 0; index < 20; index += 1) {
      drafts.push(await input(node, first.versionId, `draft ${String(index)}\n`));
    }
    // The host's project queue is smaller than this, so some wait is refused before the race.
    const results = await Promise.all(drafts.map((draft) => engine.saveDraft(draft)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.filter((result) => !result.ok).map(codeOf);
    expect(refused).toContain('engine.version_conflict');
    expect(refused.filter((code) => !BUSY_OR_LOST.includes(code))).toEqual([]);
    expect(await versionCount(node)).toBe(2);
  });

  it('returns the first version for the same key and the same input', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'once\n');
    const first = await engine.saveDraft(draft);
    const again = await engine.saveDraft(draft);
    expect(first.ok).toBe(true);
    expect(again).toEqual(first);
    expect(await versionCount(node)).toBe(1);
  });

  it('still returns it after the head has moved', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'once\n');
    const first = await engine.saveDraft(draft);
    if (!first.ok) throw new Error('refused');
    await save(built, home, node, first.value.versionId, 'later\n');
    expect(await engine.saveDraft(draft)).toEqual(first);
    expect(await versionCount(node)).toBe(2);
  });

  it('returns one version to two racing retries', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'once\n');
    const results = await Promise.all([engine.saveDraft(draft), engine.saveDraft(draft)]);
    expect(results.map(codeOf)).toEqual(['ok', 'ok']);
    expect(results[0]).toEqual(results[1]);
    expect(await versionCount(node)).toBe(1);
  });

  it('refuses the same key with other content', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'once\n');
    const first = await engine.saveDraft(draft);
    if (!first.ok) throw new Error('refused');
    const other = await input(node, first.value.versionId, 'other\n');
    expect(codeOf(await engine.saveDraft({ ...other, idempotencyKey: draft.idempotencyKey }))).toBe(
      'engine.idempotency_conflict',
    );
    expect(await versionCount(node)).toBe(1);
  });

  it('refuses the same key on another node, and with another origin', async () => {
    const node = await newNode(engine, home);
    const spare = await newNode(engine, home);
    const draft = await input(node, null, 'once\n');
    await engine.saveDraft(draft);
    expect(codeOf(await engine.saveDraft({ ...draft, nodeId: spare }))).toBe(
      'engine.idempotency_conflict',
    );
    expect(codeOf(await engine.saveDraft({ ...draft, origin: 'ai' }))).toBe(
      'engine.idempotency_conflict',
    );
    expect(await versionCount(spare)).toBe(0);
  });

  it('settles one key raced across two nodes', async () => {
    const left = await newNode(engine, home);
    const right = await newNode(engine, home);
    const draft = await input(left, null, 'once\n');
    const results = await Promise.all([
      engine.saveDraft(draft),
      engine.saveDraft({ ...draft, nodeId: right }),
    ]);
    expect(results.map(codeOf).sort()).toEqual(['engine.idempotency_conflict', 'ok']);
    expect((await versionCount(left)) + (await versionCount(right))).toBe(1);
  });

  it('keeps a key to its project', async () => {
    const other = await seed({ organization: home.organization });
    const here = await newNode(engine, home);
    const there = await newNode(engine, other);
    const draft = await input(here, null, 'once\n');
    await engine.saveDraft(draft);
    const done = await engine.saveDraft({ ...draft, tenant: other.tenant, nodeId: there });
    expect(codeOf(done)).toBe('ok');
  });

  it('refuses a forged tree whose raw is not what its nodes say', async () => {
    const node = await newNode(engine, home);
    const honest = await tree(parse, home, 'harmless\n');
    const [block] = honest.children;
    const forged = {
      ...honest,
      children: [{ ...block, source: { ...block?.source, raw: '<script>alert(1)</script>\n' } }],
    };
    const done = await engine.saveDraft({
      ...(await input(node, null, 'x\n')),
      content: forged as never,
    });
    expect(done).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
    expect(await versionCount(node)).toBe(0);
  });

  it('refuses the same forgery with its hashes recomputed', async () => {
    const node = await newNode(engine, home);
    const honest = await tree(parse, home, 'harmless\n');
    const [block] = honest.children;
    const raw = '<script>alert(1)</script>\n';
    const gapBefore = block?.source?.gapBefore ?? '';
    const treeHash = block?.source?.rawOf ?? '';
    const sourceOf = createHash('sha256')
      .update(`${treeHash}:${String(gapBefore.length)}:${gapBefore}${raw}`)
      .digest('hex');
    const forged = {
      ...honest,
      children: [{ ...block, source: { ...block?.source, raw, sourceOf } }],
    };
    const done = await engine.saveDraft({
      ...(await input(node, null, 'x\n')),
      content: forged as never,
    });
    expect(done).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
    expect(await versionCount(node)).toBe(0);
  });

  it('prints a new block with no source and stores what came back', async () => {
    const node = await newNode(engine, home);
    const content = await tree(parse, home, 'First\n');
    const added = {
      ...content,
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Written here' }] }],
    };
    const done = await engine.saveDraft({
      ...(await input(node, null, 'x\n')),
      content: added as never,
    });
    expect(codeOf(done)).toBe('ok');
    const head = await engine.getHead(home.tenant, node);
    const [stored] = head.ok ? (head.value.content?.children ?? []) : [];
    expect(stored?.source?.raw).toBe('Written here');
  });

  it('refuses a block whose stored hash went stale', async () => {
    const node = await newNode(engine, home);
    const honest = await tree(parse, home, 'a\n');
    const [block] = honest.children;
    const stale = {
      ...honest,
      children: [{ ...block, source: { ...block?.source, rawOf: '0'.repeat(64) } }],
    };
    const done = await engine.saveDraft({
      ...(await input(node, null, 'x\n')),
      content: stale as never,
    });
    expect(codeOf(done)).toBe('engine.validation_failed');
    expect(await versionCount(node)).toBe(0);
  });

  it.each([
    ['an unknown version', (root: object) => ({ ...root, astVersion: 999 }), 'astVersion'],
    ['an unknown key', (root: object) => ({ ...root, extra: 1 }), 'content'],
    [
      'a lone surrogate',
      (root: object) => ({ ...root, tail: String.fromCharCode(0xd800) }),
      'content.tail',
    ],
    ['a NUL', (root: object) => ({ ...root, tail: '\u0000' }), 'content.tail'],
  ])('refuses %s with its path and stores nothing', async (_name, change, path) => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'a\n');
    const done = await engine.saveDraft({ ...draft, content: change(draft.content) as never });
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    if (!done.ok) {
      expect(done.error.issues.map((issue) => issue.path).join()).toContain(path);
    }
    expect(await versionCount(node)).toBe(0);
  });

  it('refuses a page with a NUL before Postgres can, with the same code', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'a\n');
    const [block] = draft.content.children;
    const done = await engine.saveDraft({
      ...draft,
      content: {
        ...draft.content,
        children: [{ ...block, source: { ...block?.source, raw: 'a\u0000\n' } }],
      } as never,
    });
    expect(codeOf(done)).toBe('engine.validation_failed');
  });

  it('refuses a tree too deep to walk without touching the stack', async () => {
    const node = await newNode(engine, home);
    let deep: unknown = { type: 'text', value: 'x' };
    for (let level = 0; level < 200_000; level += 1) {
      deep = { type: 'emphasis', children: [deep] };
    }
    const draft = await input(node, null, 'a\n');
    const done = await engine.saveDraft({
      ...draft,
      content: {
        ...draft.content,
        children: [{ type: 'paragraph', children: [deep] }],
      } as never,
    });
    expect(codeOf(done)).toBe('engine.too_large');
  });

  it('refuses a small page whose stored tree is past the cap', async () => {
    const tight = buildEngine(db, {
      config: { maxNodeBytes: 1_048_576, maxTreeBytes: 4_096 },
    }).engine;
    const node = await newNode(tight, home);
    const page = 'a\n\n'.repeat(100);
    const done = await tight.saveDraft(await input(node, null, page));
    expect(codeOf(done)).toBe('engine.too_large');
    expect(await versionCount(node)).toBe(0);
  });

  // Built by copying one block, as parsing a page this size can pass the host's kill on a slow
  // runner. The cap has to refuse it before the host sees it anyway.
  it('refuses a tree past the default cap without asking the host', async () => {
    const print = vi.fn<ParseClient['print']>((request) => parse.print(request));
    const capped = buildEngine(db, { parse: { print } }).engine;
    const node = await newNode(capped, home);
    const draft = await input(node, null, `${'a'.repeat(100)}\n`);
    const [block] = draft.content.children;
    const done = await capped.saveDraft({
      ...draft,
      content: { ...draft.content, children: new Array(24_000).fill(block) },
    });
    expect(done).toMatchObject({
      ok: false,
      error: { code: 'engine.too_large', issues: [{ code: 'tree.too_large' }] },
    });
    expect(print).not.toHaveBeenCalled();
    expect(await versionCount(node)).toBe(0);
  });

  it('refuses source past the node cap', async () => {
    const tight = buildEngine(db, {
      config: { maxNodeBytes: 8, maxTreeBytes: 1_048_576 },
    }).engine;
    const node = await newNode(tight, home);
    const done = await tight.saveDraft(await input(node, null, 'twelve bytes\n'));
    expect(codeOf(done)).toBe('engine.too_large');
  });

  it('turns a parser refusal into a validation failure', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'a\n');
    const [block] = draft.content.children;
    const done = await engine.saveDraft({
      ...draft,
      content: {
        ...draft.content,
        children: [{ ...block, source: { ...block?.source, raw: '<Broken\n' } }],
      } as never,
    });
    expect(codeOf(done)).toBe('engine.validation_failed');
    expect(await versionCount(node)).toBe(0);
  });

  it('stays out of the way when the parse host is down: retryable, nothing stored', async () => {
    const down = buildEngine(db, {
      parse: {
        print: () =>
          Promise.resolve({
            ok: false,
            error: [{ code: 'mdx.parse_unavailable', severity: 'error', line: 1, column: 1 }],
          }),
      },
    }).engine;
    const node = await newNode(down, home);
    const done = await down.saveDraft(await input(node, null, 'a\n'));
    expect(done).toMatchObject({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true },
    });
    expect(await versionCount(node)).toBe(0);
  });

  it('refuses a parse host answer that is not a valid tree', async () => {
    const warn = vi.fn();
    const honest = await tree(parse, home, 'a\n');
    const lying = buildEngine(db, {
      logger: { info: () => undefined, warn },
      parse: {
        print: () =>
          Promise.resolve({
            ok: true,
            value: { ast: { ...honest, astVersion: 999 } as never, text: 'a\n', issues: [] },
          }),
      },
    }).engine;
    const node = await newNode(lying, home);
    const done = await lying.saveDraft(await input(node, null, 'a\n'));
    expect(codeOf(done)).toBe('engine.unavailable');
    expect(await versionCount(node)).toBe(0);
    expect(warn).toHaveBeenCalledWith('engine.parse_answer_refused', expect.anything());
  });

  it('writes nothing when a step fails inside the transaction', async () => {
    const node = await newNode(engine, home);
    const trigger = `fail_${node.replaceAll('-', '')}`;
    await admin(`
create function public.${trigger}() returns trigger language plpgsql as
  $$ begin raise exception 'injected'; end $$;
create trigger ${trigger} before update on app.nodes for each row
  when (old.id = '${node}') execute function public.${trigger}();`);
    try {
      await expect(engine.saveDraft(await input(node, null, 'a\n'))).rejects.toThrow();
      expect(await versionCount(node)).toBe(0);
    } finally {
      await admin(`
drop trigger ${trigger} on app.nodes;
drop function public.${trigger}();`);
    }
    const head = await engine.getHead(home.tenant, node);
    expect(head.ok && head.value.versionId).toBeNull();
  });

  it('logs ids and hashes, never content', async () => {
    const lines: string[] = [];
    const logger: EngineLogger = {
      info: (event, fields) => lines.push(JSON.stringify({ event, fields })),
      warn: (event, fields) => lines.push(JSON.stringify({ event, fields })),
    };
    const quiet = buildEngine(db, { logger }).engine;
    const node = await newNode(quiet, home);
    const canary = 'CANARY-PAGE-TEXT';
    const email = 'person@example.com';
    const done = await quiet.saveDraft({
      ...(await input(node, null, `${canary}\n`)),
      actor: { kind: 'git', installationId: 'i-1', commitSha: 'a'.repeat(40), authorEmail: email },
    });
    expect(done.ok).toBe(true);
    await quiet.saveDraft(await input(node, null, `${canary} refused\n`));
    const log = lines.join('\n');
    expect(log).not.toContain(canary);
    expect(log).not.toContain(email);
    expect(log).toContain(home.organization);
    expect(log).toContain(home.project);
    expect(log).toContain(node);
    expect(log).toContain('content_sha256');
  });
});

describeWithStack('rollback against Postgres', () => {
  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine, parse } = built);
    home = await seed();
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  const roll = (node: NodeId, to: VersionId, expected: VersionId, seeded: Seeded = home) =>
    engine.rollback({
      tenant: seeded.tenant,
      nodeId: node,
      toVersionId: to,
      expectedHeadVersionId: expected,
      actor: ACTOR,
      idempotencyKey: key(),
    });

  it('adds a version holding the old content and keeps every version', async () => {
    const node = await newNode(engine, home);
    const one = await save(built, home, node, null, 'one\n');
    const two = await save(built, home, node, one.versionId, 'two\n');
    const back = await roll(node, one.versionId, two.versionId);
    expect(back).toMatchObject({ ok: true, value: { seq: 3 } });
    const head = await engine.getHead(home.tenant, node);
    expect(head.ok && head.value.content).toEqual(await tree(parse, home, 'one\n'));
    expect(await versionCount(node)).toBe(3);
  });

  it('keeps the origin of what it brings back, so a model draft stays one', async () => {
    const node = await newNode(engine, home);
    const draft = await input(node, null, 'from a model\n');
    const first = await engine.saveDraft({ ...draft, origin: 'ai' });
    if (!first.ok) throw new Error('refused');
    const two = await save(built, home, node, first.value.versionId, 'edited\n');
    const back = await roll(node, first.value.versionId, two.versionId);
    if (!back.ok) throw new Error('refused');
    const origin = await admin(
      `select origin from app.node_versions where id = '${back.value.versionId}';`,
    );
    expect(origin).toBe('ai');
  });

  it('conflicts on a stale head and adds nothing', async () => {
    const node = await newNode(engine, home);
    const one = await save(built, home, node, null, 'one\n');
    await save(built, home, node, one.versionId, 'two\n');
    expect(codeOf(await roll(node, one.versionId, one.versionId))).toBe('engine.version_conflict');
    expect(await versionCount(node)).toBe(2);
  });

  it('replays on the same key', async () => {
    const node = await newNode(engine, home);
    const one = await save(built, home, node, null, 'one\n');
    const two = await save(built, home, node, one.versionId, 'two\n');
    const ask = {
      tenant: home.tenant,
      nodeId: node,
      toVersionId: one.versionId,
      expectedHeadVersionId: two.versionId,
      actor: ACTOR,
      idempotencyKey: key(),
    };
    const first = await engine.rollback(ask);
    expect(await engine.rollback(ask)).toEqual(first);
    expect(await versionCount(node)).toBe(3);
  });

  it('refuses the same key with another target', async () => {
    const node = await newNode(engine, home);
    const one = await save(built, home, node, null, 'one\n');
    const two = await save(built, home, node, one.versionId, 'two\n');
    const ask = {
      tenant: home.tenant,
      nodeId: node,
      toVersionId: one.versionId,
      expectedHeadVersionId: two.versionId,
      actor: ACTOR,
      idempotencyKey: key(),
    };
    await engine.rollback(ask);
    expect(codeOf(await engine.rollback({ ...ask, toVersionId: two.versionId }))).toBe(
      'engine.idempotency_conflict',
    );
  });

  it('refuses a version of another node in the same project', async () => {
    const node = await newNode(engine, home);
    const spare = await newNode(engine, home);
    const mine = await save(built, home, node, null, 'mine\n');
    const theirs = await save(built, home, spare, null, 'theirs\n');
    expect(codeOf(await roll(node, theirs.versionId, mine.versionId))).toBe('engine.not_found');
  });
});

describeWithStack('tenancy against Postgres', () => {
  let other: Seeded;
  let sibling: Seeded;
  let node: NodeId;
  let saved: VersionId;

  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine, parse } = built);
    home = await seed();
    other = await seed();
    sibling = await seed({ organization: home.organization });
    node = await newNode(engine, home);
    saved = (await save(built, home, node, null, 'mine\n')).versionId;
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  const everyone = () =>
    [
      ['another organization', other],
      ['another project of the organization', sibling],
    ] as const;

  it('hides a node from every other tenant, on every call', async () => {
    for (const [, seeded] of everyone()) {
      const { tenant } = seeded;
      const draft = await input(node, saved, 'theirs\n', seeded);
      expect(codeOf(await engine.saveDraft(draft))).toBe('engine.not_found');
      expect(codeOf(await engine.getHead(tenant, node))).toBe('engine.not_found');
      expect(codeOf(await engine.listVersions(tenant, node, {}))).toBe('engine.not_found');
      expect(
        codeOf(
          await engine.rollback({
            tenant,
            nodeId: node,
            toVersionId: saved,
            expectedHeadVersionId: saved,
            actor: ACTOR,
            idempotencyKey: key(),
          }),
        ),
      ).toBe('engine.not_found');
    }
    expect(await versionCount(node)).toBe(1);
  });

  it('answers the same for an id that never existed', async () => {
    const ghost = idOf('nod', randomUUID());
    expect(await engine.getHead(other.tenant, ghost)).toEqual(
      await engine.getHead(other.tenant, node),
    );
  });

  it('refuses another tenant type and parent when creating a node', async () => {
    for (const [, seeded] of everyone()) {
      expect(
        codeOf(
          await engine.createNode({
            tenant: seeded.tenant,
            family: 'docs_page',
            typeId: home.typeId,
          }),
        ),
      ).toBe('engine.not_found');
      expect(
        codeOf(
          await engine.createNode({
            tenant: seeded.tenant,
            family: 'docs_page',
            typeId: seeded.typeId,
            parentId: node,
          }),
        ),
      ).toBe('engine.not_found');
    }
  });

  it('refuses a family its type does not have', async () => {
    expect(
      codeOf(
        await engine.createNode({
          tenant: home.tenant,
          family: 'studio_item',
          typeId: home.typeId,
        }),
      ),
    ).toBe('engine.validation_failed');
  });

  it('creates a child under a parent of the tenant', async () => {
    const child = await engine.createNode({
      tenant: home.tenant,
      family: 'docs_page',
      typeId: home.typeId,
      parentId: node,
      slug: 'child',
      orderKey: 'a1',
    });
    expect(child.ok).toBe(true);
  });

  it('lets each tenant save only under its own context', async () => {
    const theirs = await newNode(engine, other);
    const done = await save(built, other, theirs, null, 'theirs\n');
    const rows = await admin(
      `select organization_id = '${other.organization}' from app.node_versions
        where id = '${done.versionId}';`,
    );
    expect(rows).toBe('t');
  });

  it('pages through versions newest first', async () => {
    const pages = await newNode(engine, home);
    let at: VersionId | null = null;
    for (const text of ['1\n', '2\n', '3\n']) {
      at = (await save(built, home, pages, at, text)).versionId;
    }
    const first = await engine.listVersions(home.tenant, pages, { limit: 2 });
    expect(first.ok && first.value.items.map((item) => item.seq)).toEqual([3, 2]);
    const before = first.ok ? first.value.nextBefore : null;
    expect(before).toBe(2);
    const second = await engine.listVersions(home.tenant, pages, { limit: 2, before: before ?? 0 });
    expect(second.ok && second.value.items.map((item) => item.seq)).toEqual([1]);
    expect(second.ok && second.value.nextBefore).toBeNull();
  });

  it('lists no content', async () => {
    const listed = await engine.listVersions(home.tenant, node, {});
    expect(JSON.stringify(listed)).not.toContain('mine');
  });
});
