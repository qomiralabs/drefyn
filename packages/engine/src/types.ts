import type { IdOf, TenantRef, UserId } from '@drefyn/tenancy';
import type { SystemJob } from './actor.ts';
import type { NodeContent } from './content.ts';
import type { StoredFields } from './fields.ts';
import type { NodeFamily, NodeLifecycle, Origin } from './vocabulary.ts';

export type NodeId = IdOf<'nod'>;
export type VersionId = IdOf<'ver'>;
export type IdempotencyKey = string;

export type Actor =
  | { readonly kind: 'user'; readonly userId: UserId; readonly roles: readonly string[] }
  | { readonly kind: 'api_key'; readonly keyId: string; readonly scopes: readonly string[] }
  | {
      readonly kind: 'git';
      readonly installationId: string;
      readonly commitSha: string;
      readonly authorEmail: string;
    }
  | { readonly kind: 'system'; readonly job: string };

// What a move takes: the same, with a job from the closed list, so a job name built at runtime
// does not compile.
export type MovingActor =
  | Exclude<Actor, { readonly kind: 'system' }>
  | { readonly kind: 'system'; readonly job: SystemJob };

export interface CreateNodeInput {
  readonly tenant: TenantRef;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly parentId?: NodeId | null;
  readonly slug?: string | null;
  // Absent lands after the last sibling. A caller that sends one owns any tie it makes.
  readonly orderKey?: string;
}

export interface MoveNodeInput {
  readonly tenant: TenantRef;
  readonly nodeId: NodeId;
  // Null moves it to the root.
  readonly parentId: NodeId | null;
  // The child of parentId it lands after. Null puts it first.
  readonly afterId: NodeId | null;
  readonly actor: MovingActor;
}

export interface SaveDraftInput {
  readonly tenant: TenantRef;
  readonly nodeId: NodeId;
  // Null only on the first save.
  readonly expectedHeadVersionId: VersionId | null;
  readonly content: NodeContent;
  readonly origin: Origin;
  readonly actor: Actor;
  readonly idempotencyKey: IdempotencyKey;
  // Field id to value, as an API sends them: decimal strings, ISO dates, booleans and lists.
  // Absent keeps the head's values, so a body edit cannot wipe them.
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface RollbackInput {
  readonly tenant: TenantRef;
  readonly nodeId: NodeId;
  readonly toVersionId: VersionId;
  readonly expectedHeadVersionId: VersionId;
  readonly actor: Actor;
  readonly idempotencyKey: IdempotencyKey;
}

export interface NodeRef {
  readonly nodeId: NodeId;
  readonly family: NodeFamily;
  readonly typeId: string;
}

export interface VersionRef {
  readonly nodeId: NodeId;
  readonly versionId: VersionId;
  readonly seq: number;
  readonly contentSha256: string;
}

export interface NodeHead {
  readonly nodeId: NodeId;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly lifecycle: NodeLifecycle;
  readonly versionId: VersionId | null;
  readonly seq: number | null;
  readonly astVersion: number | null;
  readonly content: NodeContent | null;
  readonly fields: StoredFields;
}

export interface VersionSummary {
  readonly versionId: VersionId;
  readonly seq: number;
  readonly parentVersionId: VersionId | null;
  readonly origin: Origin;
  readonly astVersion: number;
  readonly contentSha256: string;
  readonly createdAt: Date;
}

export interface PageArgs {
  readonly limit?: number;
  // Versions below this seq.
  readonly before?: number;
}

export type SortDirection = 'asc' | 'desc';

export interface NodeQuery {
  readonly typeId: string;
  // Checked against the type's definition, so it stays unknown until then.
  readonly filter?: unknown;
  // A declared sortable field. Absent means newest first.
  readonly sort?: { readonly field: string; readonly direction?: SortDirection };
  readonly limit?: number;
  // Opaque, from the previous page.
  readonly cursor?: string;
}

export interface NodeSummary {
  readonly nodeId: NodeId;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly lifecycle: NodeLifecycle;
  readonly slug: string | null;
  readonly versionId: VersionId | null;
  readonly updatedAt: Date;
}

export interface NodePage {
  readonly items: readonly NodeSummary[];
  readonly nextCursor: string | null;
  // Declared fields of this type still filling, so the page can say why a list may be slower.
  readonly backfilling: readonly string[];
}

export interface DeclareSchemaInput {
  readonly tenant: TenantRef;
  readonly typeId: string;
  // Parsed and validated here, so it stays unknown until then.
  readonly schema: unknown;
  // A person's confirmed choice. The caller checks who may give it.
  readonly confirmedRemovals?: readonly string[];
}

export interface DeclaredSchema {
  readonly typeId: string;
  readonly version: number;
  readonly backfills: number;
}

export type BackfillState =
  | 'idle' // nothing queued in this project
  | 'waiting' // another project of this organization holds the one turn
  | 'running' // a batch went in, more remain
  | 'finished'; // a slot finished, others may be queued

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextBefore: number | null;
}
