import type { IdOf, TenantRef, UserId } from '@drefyn/tenancy';
import type { NodeContent } from './content.ts';
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

export interface CreateNodeInput {
  readonly tenant: TenantRef;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly parentId?: NodeId | null;
  readonly slug?: string | null;
  readonly orderKey?: string;
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

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextBefore: number | null;
}
