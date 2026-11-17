import type { UserId } from '@drefyn/tenancy';
import type { Actor } from './types.ts';
import type { NodeFamily, Origin, PublishErrorCode } from './vocabulary.ts';

// A project's choices. A project that never chose gets STRICT_WORKFLOW.
export interface PublishWorkflow {
  readonly approvalRequired: boolean;
  readonly apiKeysPublish: boolean;
  readonly gitPublish: boolean;
}

export const STRICT_WORKFLOW: PublishWorkflow = Object.freeze({
  approvalRequired: false,
  apiKeysPublish: false,
  gitPublish: false,
});

// Project roles as the host resolves them. Organization owners and admins arrive as admin.
export const PUBLISH_ROLES: readonly string[] = Object.freeze(['admin', 'editor']);
// Narrower than publishing, or an editor could approve their own version and the step would
// stop no one.
export const APPROVE_ROLES: readonly string[] = Object.freeze(['admin']);

// The key scope that lets a key publish each family, from the scopes a key can be given.
export const PUBLISH_SCOPES: Readonly<Record<NodeFamily, string>> = Object.freeze({
  docs_page: 'docs:pages.publish',
  studio_item: 'studio:content.write',
  status_component: 'status:incidents.write',
  status_incident: 'status:incidents.write',
  status_incident_update: 'status:incidents.write',
  status_maintenance: 'status:incidents.write',
  status_postmortem: 'status:incidents.write',
});

export interface PublishFacts {
  readonly actor: Actor;
  readonly family: NodeFamily;
  readonly origin: Origin;
  readonly workflow: PublishWorkflow;
  // An approval of this exact version is on record.
  readonly approved: boolean;
}

const holds = (roles: readonly string[], allowed: readonly string[]) =>
  roles.some((role) => allowed.includes(role));

// Pure, so every combination can be checked against a model. Null allows. The person check
// comes first: content a model wrote, or a project that promised a review, never goes out
// through a key, a push or a job, whatever else that actor may do.
export function publishRefusal(facts: PublishFacts): PublishErrorCode | null {
  const { actor, workflow } = facts;
  const gated = facts.origin === 'ai' || workflow.approvalRequired;
  if (gated && actor.kind !== 'user') return 'publish.human_required';
  switch (actor.kind) {
    case 'user':
      if (!holds(actor.roles, PUBLISH_ROLES)) return 'publish.forbidden';
      return workflow.approvalRequired && !facts.approved ? 'publish.approval_required' : null;
    case 'api_key':
      return workflow.apiKeysPublish && actor.scopes.includes(PUBLISH_SCOPES[facts.family])
        ? null
        : 'publish.forbidden';
    case 'git':
      return workflow.gitPublish ? null : 'publish.forbidden';
    case 'system':
      return 'publish.forbidden';
  }
}

// An approval is a person's judgement, so only a person gives one. Answers who, when allowed.
export function approverOf(
  actor: Actor,
): { ok: true; value: UserId } | { ok: false; code: PublishErrorCode } {
  if (actor.kind !== 'user') return { ok: false, code: 'publish.human_required' };
  return holds(actor.roles, APPROVE_ROLES)
    ? { ok: true, value: actor.userId }
    : { ok: false, code: 'publish.forbidden' };
}
