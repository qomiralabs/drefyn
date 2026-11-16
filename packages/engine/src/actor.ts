import type { LogFields } from './ports.ts';
import type { Actor } from './types.ts';

export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// GitHub's own number for an installation.
export const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;
// Every job that may move a node, named here. A pattern would still take a code built from a
// person's name, so a new job is added to this list, never assembled from a field.
export const SYSTEM_JOBS = Object.freeze(['bench', 'test'] as const);
export type SystemJob = (typeof SYSTEM_JOBS)[number];

const isSystemJob = (id: string): id is SystemJob =>
  (SYSTEM_JOBS as readonly string[]).includes(id);

const SHAPES: Readonly<Record<Actor['kind'], (id: string) => boolean>> = {
  user: (id) => CANONICAL_UUID.test(id),
  api_key: (id) => CANONICAL_UUID.test(id),
  git: (id) => INSTALLATION_ID.test(id),
  system: isSystemJob,
};

export function isOpaqueActorId(kind: Actor['kind'], id: string): boolean {
  return SHAPES[kind](id);
}

const idOfActor = (actor: Actor): string => {
  switch (actor.kind) {
    case 'user':
      return actor.userId;
    case 'api_key':
      return actor.keyId;
    case 'git':
      return actor.installationId;
    case 'system':
      return actor.job;
  }
};

// A move overwrites its row, so unlike a save it leaves no version to say who did it, and this
// line is the record. It reaches traces as well as logs. Checked here and not only at the
// input, because the type takes any string and saves accept wider shapes: an id that is not
// opaque is left out, and the kind still says who it was.
export function actorFields(actor: Actor): LogFields {
  const id = idOfActor(actor);
  return isOpaqueActorId(actor.kind, id)
    ? { actor_kind: actor.kind, actor_id: id }
    : { actor_kind: actor.kind };
}
