import { idOf } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NODE_FAMILIES,
  PUBLISH_ROLES,
  PUBLISH_SCOPES,
  type Actor,
  type NodeFamily,
  type PublishWorkflow,
} from '../src/index.ts';
import { heldVisibility, visibilityRefusal } from '../src/visibility.ts';

const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099');
const MACHINE = '01890a5d-ac96-774b-bcce-b302099a8098';

const ROLES = ['admin', 'editor', 'viewer', 'billing', 'owner'];
const SCOPES = [...new Set(Object.values(PUBLISH_SCOPES)), 'docs:pages.read', 'studio:read'];

const actorArb: fc.Arbitrary<Actor> = fc.oneof(
  fc.record({
    kind: fc.constant('user' as const),
    userId: fc.constant(USER),
    roles: fc.subarray(ROLES),
  }),
  fc.record({
    kind: fc.constant('api_key' as const),
    keyId: fc.constant(MACHINE),
    scopes: fc.subarray(SCOPES),
  }),
  fc.record({
    kind: fc.constant('git' as const),
    installationId: fc.constant('42'),
    commitSha: fc.constant('a'.repeat(40)),
    authorEmail: fc.constant('dev@example.com'),
  }),
  fc.record({ kind: fc.constant('system' as const), job: fc.constantFrom('test', 'bench', 'ai') }),
);

const workflowArb: fc.Arbitrary<PublishWorkflow> = fc.record({
  approvalRequired: fc.boolean(),
  apiKeysPublish: fc.boolean(),
  gitPublish: fc.boolean(),
});

const familyArb = fc.constantFrom<NodeFamily>(...NODE_FAMILIES);

// The model, written from the rule and not from the code.
const personWhoPublishes = (actor: Actor) =>
  actor.kind === 'user' && actor.roles.some((role) => PUBLISH_ROLES.includes(role));

const mayPublish = (actor: Actor, family: NodeFamily, workflow: PublishWorkflow) => {
  switch (actor.kind) {
    case 'user':
      return personWhoPublishes(actor);
    case 'api_key':
      return workflow.apiKeysPublish && actor.scopes.includes(PUBLISH_SCOPES[family]);
    case 'git':
      return workflow.gitPublish;
    case 'system':
      return false;
  }
};

describe('who may change visibility', () => {
  it('lets only a person with the publish permission widen, whatever the project allows', () => {
    fc.assert(
      fc.property(actorArb, familyArb, workflowArb, (actor, family, workflow) => {
        const refusal = visibilityRefusal({ actor, family, workflow, widens: true });
        if (personWhoPublishes(actor)) expect(refusal).toBeNull();
        else expect(refusal).toBe('engine.widen_requires_publish');
      }),
      { numRuns: 2000 },
    );
  });

  it('lets any actor that may publish tighten, and never a job', () => {
    fc.assert(
      fc.property(actorArb, familyArb, workflowArb, (actor, family, workflow) => {
        const refusal = visibilityRefusal({ actor, family, workflow, widens: false });
        expect(refusal).toBe(mayPublish(actor, family, workflow) ? null : 'engine.forbidden');
        if (actor.kind === 'system') expect(refusal).toBe('engine.forbidden');
      }),
      { numRuns: 2000 },
    );
  });

  it('never lets a key, a push or a job widen, even with every right a project can give', () => {
    const open: PublishWorkflow = {
      approvalRequired: false,
      apiKeysPublish: true,
      gitPublish: true,
    };
    const machines: readonly Actor[] = [
      { kind: 'api_key', keyId: MACHINE, scopes: SCOPES },
      { kind: 'git', installationId: '42', commitSha: 'a'.repeat(40), authorEmail: 'a@b.c' },
      { kind: 'system', job: 'test' },
    ];
    for (const actor of machines) {
      for (const family of NODE_FAMILIES) {
        expect(visibilityRefusal({ actor, family, workflow: open, widens: true })).toBe(
          'engine.widen_requires_publish',
        );
      }
    }
  });

  it.each<[string, Actor, string | null]>([
    ['an editor', { kind: 'user', userId: USER, roles: ['editor'] }, null],
    ['an admin', { kind: 'user', userId: USER, roles: ['admin'] }, null],
    ['a viewer', { kind: 'user', userId: USER, roles: ['viewer'] }, 'engine.forbidden'],
    ['a job', { kind: 'system', job: 'test' }, 'engine.forbidden'],
  ])('tightening by %s', (_name, actor, expected) => {
    const workflow = { approvalRequired: false, apiKeysPublish: true, gitPublish: true };
    expect(visibilityRefusal({ actor, family: 'docs_page', workflow, widens: false })).toBe(
      expected,
    );
  });
});

describe('what publish writes', () => {
  it('keeps protected rows protected, and otherwise writes what the tree says', () => {
    expect(heldVisibility('public', true)).toBe('protected');
    expect(heldVisibility('protected', true)).toBe('protected');
    expect(heldVisibility('protected', false)).toBe('protected');
    expect(heldVisibility('public', false)).toBe('public');
  });
});
