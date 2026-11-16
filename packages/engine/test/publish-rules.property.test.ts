import { idOf } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { approverOf, publishRefusal, type PublishFacts } from '../src/publish-rules.ts';
import type { Actor } from '../src/types.ts';
import { NODE_FAMILIES, ORIGINS, type NodeFamily } from '../src/vocabulary.ts';

const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8099');
const MACHINE = '01890a5d-ac96-774b-bcce-b302099a8098';

// Roles and scopes a host could pass, including ones that mean nothing to the gate.
const ROLE_POOL = ['admin', 'editor', 'viewer', 'owner', 'member', 'Admin', ''];
const SCOPE_POOL = [
  'docs:pages.publish',
  'docs:pages.read',
  'studio:content.write',
  'studio:content.read',
  'status:incidents.write',
  'status:status.read',
  'read:published',
];

const actorArb: fc.Arbitrary<Actor> = fc.oneof(
  fc.subarray(ROLE_POOL).map((roles): Actor => ({ kind: 'user', userId: USER, roles })),
  fc.subarray(SCOPE_POOL).map((scopes): Actor => ({ kind: 'api_key', keyId: MACHINE, scopes })),
  fc.constant<Actor>({
    kind: 'git',
    installationId: '42',
    commitSha: 'a'.repeat(40),
    authorEmail: 'dev@example.com',
  }),
  fc.constantFrom<Actor>({ kind: 'system', job: 'test' }, { kind: 'system', job: 'staleness' }),
);

const factsArb: fc.Arbitrary<PublishFacts> = fc.record({
  actor: actorArb,
  family: fc.constantFrom(...NODE_FAMILIES),
  origin: fc.constantFrom(...ORIGINS),
  workflow: fc.record({
    approvalRequired: fc.boolean(),
    apiKeysPublish: fc.boolean(),
    gitPublish: fc.boolean(),
  }),
  approved: fc.boolean(),
});

// The rules as written down, one line each, checked in this order. Kept apart from the code
// on purpose: it spells each scope and role out instead of sharing the code's tables.
const scopeFor = (family: NodeFamily): string => {
  if (family === 'docs_page') return 'docs:pages.publish';
  if (family === 'studio_item') return 'studio:content.write';
  return 'status:incidents.write';
};

function model(f: PublishFacts): string {
  const { actor, workflow } = f;
  const person = actor.kind === 'user';
  if (!person && (f.origin === 'ai' || workflow.approvalRequired)) return 'publish.human_required';
  if (actor.kind === 'system') return 'publish.forbidden';
  if (actor.kind === 'git') return workflow.gitPublish ? 'ok' : 'publish.forbidden';
  if (actor.kind === 'api_key') {
    if (!workflow.apiKeysPublish) return 'publish.forbidden';
    return actor.scopes.includes(scopeFor(f.family)) ? 'ok' : 'publish.forbidden';
  }
  const mayPublish = actor.roles.includes('admin') || actor.roles.includes('editor');
  if (!mayPublish) return 'publish.forbidden';
  if (workflow.approvalRequired && !f.approved) return 'publish.approval_required';
  return 'ok';
}

const RUNS = { numRuns: 5000 };

describe('the publish rules', () => {
  it('give the model answer for every role, workflow and actor combination', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        expect(publishRefusal(facts) ?? 'ok').toBe(model(facts));
      }),
      RUNS,
    );
  });

  it('never let AI origin or approval gated content out with a non user actor', () => {
    const gated = factsArb.filter(
      (facts) =>
        facts.actor.kind !== 'user' && (facts.origin === 'ai' || facts.workflow.approvalRequired),
    );
    fc.assert(
      fc.property(gated, (facts) => {
        expect(publishRefusal(facts)).toBe('publish.human_required');
      }),
      RUNS,
    );
  });

  it('let a non user actor publish only human authored content its project allows', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        if (facts.actor.kind === 'user' || publishRefusal(facts) !== null) return;
        expect(facts.origin).not.toBe('ai');
        expect(facts.workflow.approvalRequired).toBe(false);
        expect(facts.actor.kind).not.toBe('system');
        if (facts.actor.kind === 'api_key') expect(facts.workflow.apiKeysPublish).toBe(true);
        if (facts.actor.kind === 'git') expect(facts.workflow.gitPublish).toBe(true);
      }),
      RUNS,
    );
  });

  it('never let a system job publish, whatever the workflow', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const system = { ...facts, actor: { kind: 'system', job: 'test' } as const };
        expect(publishRefusal(system)).not.toBeNull();
      }),
      RUNS,
    );
  });

  it('take an approval only from a person with the admin role', () => {
    fc.assert(
      fc.property(actorArb, (actor) => {
        const answer = approverOf(actor);
        if (actor.kind !== 'user') {
          expect(answer).toEqual({ ok: false, code: 'publish.human_required' });
        } else if (actor.roles.includes('admin')) {
          expect(answer).toEqual({ ok: true, value: USER });
        } else {
          expect(answer).toEqual({ ok: false, code: 'publish.forbidden' });
        }
      }),
      RUNS,
    );
  });
});
