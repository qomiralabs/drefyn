import { closeDatabase, type Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type Actor,
  type EngineStore,
  type NodeId,
  type PublishInput,
  type VersionId,
} from '../../src/index.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  database,
  key,
  newNode,
  openDatabase,
  save,
  seed,
  tree,
  type Built,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { urlFor } from '../support/stack.ts';
import {
  declare,
  fieldId,
  itemEngine,
  newItem,
  saveItem,
  seedItems,
  textField,
} from '../support/typed-items.ts';

const ADMIN: Actor = {
  kind: 'user',
  userId: idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8091'),
  roles: ['admin'],
};
const KEY: Actor = {
  kind: 'api_key',
  keyId: '01890a5d-ac96-774b-bcce-b302099a8098',
  scopes: ['docs:pages.publish'],
};

let db: Database;
let built: Built;
let home: Seeded;
let other: Seeded;

beforeAll(async () => {
  db = await openDatabase();
  built = buildEngine(db);
  home = await seed();
  other = await seed();
});

afterAll(async () => {
  await closeDatabase(db);
});

const publishInput = (
  seeded: Seeded,
  nodeId: NodeId,
  versionId: VersionId,
  over: Partial<PublishInput> = {},
): PublishInput => ({
  tenant: seeded.tenant,
  nodeId,
  versionId,
  expectedHeadVersionId: versionId,
  actor: ACTOR,
  idempotencyKey: key(),
  ...over,
});

const workflow = (seeded: Seeded, columns: string) =>
  admin(`
insert into app.publish_workflows (organization_id, project_id, approval_required,
    api_keys_publish, git_publish)
  values ('${seeded.organization}', '${seeded.project}', ${columns})
  on conflict (organization_id, project_id) do update
    set approval_required = excluded.approval_required,
        api_keys_publish = excluded.api_keys_publish, git_publish = excluded.git_publish;`);

// Everything publish can touch for one node, so a test can say nothing moved.
const stateOf = (node: string) =>
  admin(`
select json_build_object(
  'versions', (select coalesce(json_agg(json_build_object('v', version_id, 'current', is_current)
                 order by version_id), '[]') from app.published_versions where node_id = '${node}'),
  'filters', (select count(*) from app.published_filter_rows where node_id = '${node}'),
  'log', (select count(*) from app.publish_log where node_id = '${node}'),
  'node', (select json_build_object('lifecycle', lifecycle, 'published', published_version_id)
             from app.nodes where id = '${node}'))::text;`);

const draft = async (seeded: Seeded, text = '# Page\n\nWords.\n') => {
  const nodeId = await newNode(built.engine, seeded);
  const first = await save(built, seeded, nodeId, null, text);
  return { nodeId, versionId: first.versionId };
};

describeWithStack('publish', () => {
  it('writes the copy, the filter row, the node and the log', async () => {
    const { nodeId, versionId } = await draft(home);
    const done = await built.engine.publish(publishInput(home, nodeId, versionId));
    expect(done.ok && done.value).toMatchObject({
      nodeId,
      versionId,
      previousVersionId: null,
      renderPolicyVersion: 1,
    });
    expect(JSON.parse(await stateOf(nodeId))).toEqual({
      versions: [{ v: versionId, current: true }],
      filters: 1,
      log: 1,
      node: { lifecycle: 'published', published: versionId },
    });
    const copied = await admin(`
select (p.content = v.content and p.fields = v.fields and p.type_id = n.type_id)::text
  from app.published_versions p
  join app.node_versions v on v.id = p.version_id
  join app.nodes n on n.id = p.node_id
 where p.node_id = '${nodeId}';`);
    expect(copied).toBe('true');
    const log = await admin(
      `select actor_kind || ' ' || actor_id from app.publish_log where node_id = '${nodeId}';`,
    );
    expect(log).toBe(`user ${ACTOR.kind === 'user' ? ACTOR.userId : ''}`);
  });

  it('marks the copy and the filter row public, also when an earlier version comes back', async () => {
    const { nodeId, versionId: first } = await draft(home);
    await built.engine.publish(publishInput(home, nodeId, first));
    const second = await save(built, home, nodeId, first, '# Page\n\nOther words.\n');
    await built.engine.publish(publishInput(home, nodeId, second.versionId));
    await built.engine.publish(
      publishInput(home, nodeId, first, { expectedHeadVersionId: second.versionId }),
    );
    const seen = await admin(`
select (select string_agg(distinct visibility, ',') from app.published_versions
         where node_id = '${nodeId}')
       || ' ' || (select visibility from app.published_filter_rows where node_id = '${nodeId}');`);
    expect(seen).toBe('public public');
  });

  it('moves the current row to the new version, and back to an earlier one', async () => {
    const { nodeId, versionId: first } = await draft(home);
    await built.engine.publish(publishInput(home, nodeId, first));
    const second = await save(built, home, nodeId, first, '# Page\n\nNewer words.\n');
    const next = await built.engine.publish(publishInput(home, nodeId, second.versionId));
    expect(next.ok && next.value.previousVersionId).toBe(first);
    const back = await built.engine.publish(
      publishInput(home, nodeId, first, { expectedHeadVersionId: second.versionId }),
    );
    expect(back.ok && back.value.previousVersionId).toBe(second.versionId);
    const state = JSON.parse(await stateOf(nodeId)) as { versions: unknown[]; log: number };
    expect(state.versions).toEqual(
      expect.arrayContaining([
        { v: first, current: true },
        { v: second.versionId, current: false },
      ]),
    );
    expect(state.versions).toHaveLength(2);
    expect(state.log).toBe(3);
  });

  it('answers not_found for another tenant node and touches nothing there', async () => {
    const { nodeId, versionId } = await draft(other);
    const done = await built.engine.publish(publishInput(home, nodeId, versionId));
    expect(done.ok || done.error.code).toBe('publish.not_found');
    expect(JSON.parse(await stateOf(nodeId))).toMatchObject({ versions: [], log: 0 });
  });

  it('refuses a key on AI drafted content even where keys may publish', async () => {
    const seeded = await seed();
    await workflow(seeded, 'false, true, false');
    const nodeId = await newNode(built.engine, seeded);
    const drafted = await built.engine.saveDraft({
      tenant: seeded.tenant,
      nodeId,
      expectedHeadVersionId: null,
      content: await tree(built.parse, seeded, '# Drafted\n\nBy a model.\n'),
      origin: 'ai',
      actor: { kind: 'system', job: 'test' },
      idempotencyKey: key(),
    });
    if (!drafted.ok) throw new Error(drafted.error.code);
    const versionId = drafted.value.versionId;
    const byKey = await built.engine.publish(
      publishInput(seeded, nodeId, versionId, { actor: KEY }),
    );
    expect(byKey.ok || byKey.error.code).toBe('publish.human_required');
    expect(JSON.parse(await stateOf(nodeId))).toMatchObject({ versions: [], log: 0 });
    const byPerson = await built.engine.publish(publishInput(seeded, nodeId, versionId));
    expect(byPerson.ok).toBe(true);
  });

  it('holds a reviewed project to an approval of that exact version', async () => {
    const seeded = await seed();
    await workflow(seeded, 'true, false, false');
    const { nodeId, versionId } = await draft(seeded);
    const early = await built.engine.publish(publishInput(seeded, nodeId, versionId));
    expect(early.ok || early.error.code).toBe('publish.approval_required');
    const byEditor = await built.engine.approve({
      tenant: seeded.tenant,
      nodeId,
      versionId,
      actor: ACTOR,
    });
    expect(byEditor.ok || byEditor.error.code).toBe('publish.forbidden');
    const approved = await built.engine.approve({
      tenant: seeded.tenant,
      nodeId,
      versionId,
      actor: ADMIN,
    });
    expect(approved.ok).toBe(true);
    const again = await built.engine.approve({
      tenant: seeded.tenant,
      nodeId,
      versionId,
      actor: ADMIN,
    });
    expect(again.ok && approved.ok && again.value.approvedAt).toEqual(
      approved.ok && approved.value.approvedAt,
    );
    const done = await built.engine.publish(publishInput(seeded, nodeId, versionId));
    expect(done.ok).toBe(true);
    // A later version is a new review.
    const later = await save(built, seeded, nodeId, versionId, '# Page\n\nChanged.\n');
    const unreviewed = await built.engine.publish(publishInput(seeded, nodeId, later.versionId));
    expect(unreviewed.ok || unreviewed.error.code).toBe('publish.approval_required');
  });

  it('answers idempotency_conflict for a reused key with other input and changes nothing', async () => {
    const { nodeId, versionId: first } = await draft(home);
    const reused = key();
    const done = await built.engine.publish(
      publishInput(home, nodeId, first, { idempotencyKey: reused }),
    );
    expect(done.ok).toBe(true);
    const second = await save(built, home, nodeId, first, '# Page\n\nSecond.\n');
    const before = await stateOf(nodeId);
    const clash = await built.engine.publish(
      publishInput(home, nodeId, second.versionId, { idempotencyKey: reused }),
    );
    expect(clash.ok || clash.error.code).toBe('publish.idempotency_conflict');
    expect(await stateOf(nodeId)).toBe(before);
    const replay = await built.engine.publish(
      publishInput(home, nodeId, first, { idempotencyKey: reused }),
    );
    expect(replay).toEqual(done);
    expect(await stateOf(nodeId)).toBe(before);
  });

  it('keeps one current row when two versions race to publish', async () => {
    const { nodeId, versionId: first } = await draft(home);
    const second = await save(built, home, nodeId, first, '# Page\n\nRacing.\n');
    const head = second.versionId;
    const results = await Promise.all([
      built.engine.publish(publishInput(home, nodeId, first, { expectedHeadVersionId: head })),
      built.engine.publish(publishInput(home, nodeId, head)),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(
      await admin(
        `select count(*) from app.published_versions where node_id = '${nodeId}' and is_current;`,
      ),
    ).toBe('1');
  });
});

describeWithStack('the publish and approval logs', () => {
  const asApp = async (text: string, values: readonly unknown[]) => {
    const client = new pg.Client({ connectionString: urlFor('app', database()) });
    await client.connect();
    try {
      await client.query(text, [...values]);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.end();
    }
  };

  it.each([
    ['update app.publish_log set actor_id = $1 where organization_id = $1'],
    ['delete from app.publish_log where organization_id = $1'],
    ['update app.publish_approvals set approved_at = now() where organization_id::text = $1'],
    ['delete from app.publish_approvals where organization_id::text = $1'],
    ['truncate app.publish_log'],
    ['truncate app.publish_approvals'],
  ])('refuse the application role: %s', async (statement) => {
    const values = statement.includes('$1') ? [home.organization] : [];
    expect(await asApp(statement, values)).toBe('42501');
  });

  it('still take a new row from the application role', async () => {
    const { nodeId, versionId } = await draft(home);
    const done = await built.engine.approve({
      tenant: home.tenant,
      nodeId,
      versionId,
      actor: ADMIN,
    });
    expect(done.ok).toBe(true);
  });
});

describeWithStack('a crash mid publish', () => {
  it('keeps nothing when the connection dies after every write, before commit', async () => {
    const real = databaseStore(db, DEFAULT_ENGINE_CONFIG);
    let arm = false;
    const dying: EngineStore = {
      ...real,
      tenant: (tenant, work) =>
        real.tenant(tenant, async (tx) => {
          const answer = await work(tx);
          if (arm) {
            const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
            await admin(`select pg_terminate_backend(${String(rows[0]?.pid)});`);
          }
          return answer;
        }),
    };
    const crashing = buildEngine(db, { store: dying });
    const { nodeId, versionId } = await draft(home);
    const before = await stateOf(nodeId);
    arm = true;
    await crashing.engine.publish(publishInput(home, nodeId, versionId)).then(
      (done) => {
        expect(done.ok).toBe(false);
      },
      () => undefined,
    );
    arm = false;
    expect(await stateOf(nodeId)).toBe(before);
  });

  it.each([
    ['the filter row', 'insert', 'published_filter_rows'],
    ['the node', 'update', 'nodes'],
  ])('keeps nothing when the server stops it at %s', async (_name, event, table) => {
    const { nodeId, versionId: first } = await draft(home);
    await built.engine.publish(publishInput(home, nodeId, first));
    const second = await save(built, home, nodeId, first, '# Page\n\nUnlucky.\n');
    const before = await stateOf(nodeId);
    const trigger = `crash_${key().replaceAll('-', '')}`;
    const column = table === 'nodes' ? 'id' : 'node_id';
    await admin(`
create function app.${trigger}() returns trigger language plpgsql as $$
begin
  if new.${column} = '${nodeId}' and current_user = 'drefyn_app' then
    raise exception 'injected';
  end if;
  return new;
end $$;
create trigger ${trigger} before ${event} on app.${table}
  for each row execute function app.${trigger}();`);
    try {
      await built.engine.publish(publishInput(home, nodeId, second.versionId)).then(
        (done) => {
          expect(done.ok).toBe(false);
        },
        () => undefined,
      );
    } finally {
      await admin(`drop trigger ${trigger} on app.${table}; drop function app.${trigger}();`);
    }
    expect(await stateOf(nodeId)).toBe(before);
  });
});

describeWithStack('a filter backfill after publish', () => {
  it('fills the published slot from the fields that went out, not the draft', async () => {
    const items = itemEngine(db);
    const seeded = await seedItems();
    const NOTE = fieldId();
    await declare(items, seeded, [textField(NOTE, 'note')]);
    const nodeId = await newItem(items, seeded);
    const first = await saveItem(items, seeded, nodeId, null, { [NOTE]: 'live' });
    const done = await items.engine.publish(publishInput(seeded, nodeId, first.versionId));
    expect(done.ok).toBe(true);
    await saveItem(items, seeded, nodeId, first.versionId, { [NOTE]: 'draft' });

    await declare(items, seeded, [textField(NOTE, 'note', { filterable: true })], 2);
    for (;;) {
      const step = await items.engine.backfillFilters(seeded.tenant);
      if (!step.ok) throw new Error(step.error.code);
      if (step.value === 'idle') break;
    }
    const column = await admin(
      `select filter_slots -> '${NOTE}' ->> 'column' from app.content_types where id = '${seeded.typeId}';`,
    );
    const read = (table: string) =>
      admin(`select ${column} from app.${table} where node_id = '${nodeId}';`);
    expect(await read('published_filter_rows')).toBe('live');
    expect(await read('node_filter_rows')).toBe('draft');
  });
});
