import { idOf, organizationId, projectId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { actorFields, isOpaqueActorId, SYSTEM_JOBS } from '../src/actor.ts';
import { moveNodeSchema, saveDraftSchema } from '../src/input.ts';
import type { Actor } from '../src/types.ts';

const USER = '01890a5d-ac96-774b-bcce-b302099a8008';
const ISSUED_ROW = '01890a5d-ac96-774b-bcce-b302099a8009';
const NODE = '01890a5d-ac96-774b-bcce-b302099a8003';
const tenant = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};

const git = (installationId: string): Actor => ({
  kind: 'git',
  installationId,
  commitSha: 'a'.repeat(40),
  authorEmail: 'author@example.com',
});

describe('the actor a log line names', () => {
  it.each<[string, Actor, string]>([
    ['a person', { kind: 'user', userId: idOf('usr', USER), roles: [] }, USER],
    ['a key', { kind: 'api_key', keyId: ISSUED_ROW, scopes: [] }, ISSUED_ROW],
    ['an installation', git('12345678'), '12345678'],
    ['a job', { kind: 'system', job: 'bench' }, 'bench'],
  ])('names %s by its id', (_name, actor, id) => {
    expect(actorFields(actor)).toEqual({ actor_kind: actor.kind, actor_id: id });
  });

  // The types allow any string, and saves take wider shapes, so the log check stands alone.
  it.each<[string, Actor]>([
    ['a job with an address in it', { kind: 'system', job: 'sync for alice@example.com' }],
    ['a job with a line break', { kind: 'system', job: 'import\nengine.move ok' }],
    ['a key id that is a name', { kind: 'api_key', keyId: 'alice', scopes: [] }],
    ['a job shaped like a code but not on the list', { kind: 'system', job: 'jane_doe' }],
    ['an installation that is an address', git('alice@example.com')],
    [
      'a user id that is not one',
      { kind: 'user', userId: 'alice@example.com' as ReturnType<typeof idOf<'usr'>>, roles: [] },
    ],
  ])('leaves out %s, and keeps the kind', (_name, actor) => {
    const fields = actorFields(actor);
    expect(fields).toEqual({ actor_kind: actor.kind });
    expect(JSON.stringify(fields)).not.toContain('alice');
  });

  it('never logs a string with an @, a space or a control character', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('user', 'api_key', 'git', 'system'),
        fc.string(),
        fc.constantFrom('@', ' ', '\n', '\t', '\u0000'),
        fc.nat(),
        (kind, text, bad, at) => {
          const cut = text.length === 0 ? 0 : at % text.length;
          const id = `${text.slice(0, cut)}${bad}${text.slice(cut)}`;
          expect(isOpaqueActorId(kind, id)).toBe(false);
        },
      ),
    );
  });
});

describe('the jobs a move can name', () => {
  it('are a closed list of codes from our own code', () => {
    expect(SYSTEM_JOBS).toEqual(['bench', 'test']);
    expect(Object.isFrozen(SYSTEM_JOBS)).toBe(true);
  });
});

describe('a move takes opaque ids only', () => {
  const moveWith = (actor: unknown) =>
    moveNodeSchema.safeParse({ tenant, nodeId: NODE, parentId: null, afterId: null, actor });

  it.each([
    ['a job of plain words', { kind: 'system', job: 'sync for alice' }],
    ['a job over 64 characters', { kind: 'system', job: 'a'.repeat(65) }],
    ['a job shaped like a host name', { kind: 'system', job: 'alice.example.com' }],
    ['a job shaped like a user name', { kind: 'system', job: 'jane_doe' }],
    ['a job with a name after a colon', { kind: 'system', job: 'export:john-smith' }],
    ['a code that is not on the list', { kind: 'system', job: 'import' }],
    ['an upper case job', { kind: 'system', job: 'Import' }],
    ['a key id in another shape', { kind: 'api_key', keyId: `drf_${ISSUED_ROW}`, scopes: [] }],
    ['an upper case key id', { kind: 'api_key', keyId: ISSUED_ROW.toUpperCase(), scopes: [] }],
    ['an installation with a leading zero', git('012')],
    ['an installation past 20 digits', git('1'.repeat(21))],
  ])('refuses %s', (_name, actor) => {
    expect(moveWith(actor).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ...SYSTEM_JOBS.map((job): [string, unknown] => [`the job ${job}`, { kind: 'system', job }]),
    ['a key', { kind: 'api_key', keyId: ISSUED_ROW, scopes: ['content:write'] }],
    ['an installation', git('1')],
    ['a person', { kind: 'user', userId: USER, roles: ['editor'] }],
  ])('takes %s', (_name, actor) => {
    expect(moveWith(actor).success).toBe(true);
  });

  it('takes nothing a log line would refuse to name', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ kind: fc.constant('system'), job: fc.string({ maxLength: 80 }) }),
          fc.record({
            kind: fc.constant('api_key'),
            keyId: fc.oneof(fc.uuid(), fc.string()),
            scopes: fc.constant([]),
          }),
        ),
        (actor) => {
          const parsed = moveWith(actor);
          if (!parsed.success) return;
          const fields = actorFields(parsed.data.actor);
          expect(fields['actor_id']).toBeDefined();
        },
      ),
    );
  });
});

describe('a save keeps the wider shapes its versions were stored with', () => {
  it.each([
    ['a job of plain words', { kind: 'system', job: 'sync for a release' }],
    ['a key id in another shape', { kind: 'api_key', keyId: 'key_1', scopes: [] }],
    ['an installation that is not a number', git('install_1')],
  ])('takes %s', (_name, actor) => {
    const parsed = saveDraftSchema.safeParse({
      tenant,
      nodeId: NODE,
      expectedHeadVersionId: null,
      content: {},
      origin: 'human',
      actor,
      idempotencyKey: 'k1',
    });
    expect(parsed.success).toBe(true);
  });
});
