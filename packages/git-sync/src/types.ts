import type { TenantRef } from '@drefyn/tenancy';

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});

export const BINDING_STATES = Object.freeze(['active', 'paused', 'error'] as const);
export type BindingState = (typeof BINDING_STATES)[number];

export const DELIVERY_STATES = Object.freeze(['queued', 'done', 'failed'] as const);
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface GitRepository {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
}

export interface GitBinding {
  readonly id: string;
  readonly tenant: TenantRef;
  readonly installationId: number;
  readonly repository: GitRepository;
  readonly branch: string;
  // '' for the repository root; never a leading '/', a trailing '/' or a '.' or '..' segment.
  readonly folder: string;
  readonly lastSyncedCommit: string | null;
  readonly state: BindingState;
  // Why the binding stopped, as a stable code such as git.unauthorized.
  readonly stateCode: string | null;
}

export interface GitFileEntry {
  readonly path: string;
  readonly nodeId: string;
  readonly blobSha: string;
  // The node version this path was last synced from or to, the base of a three way merge.
  readonly syncedVersionId: string;
}

export interface ClaimedDelivery {
  readonly id: string;
  readonly bindingId: string;
  readonly deliveryId: string;
  // Null for a reconcile, which reads the head itself.
  readonly headSha: string | null;
  readonly receivedAt: Date;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Ids, counts, durations and codes only. Never file contents, tokens, paths or author details.
export interface GitSyncLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export const noopLogger: GitSyncLogger = { info: () => undefined, warn: () => undefined };

export const tenantFields = (tenant: TenantRef): LogFields => ({
  organization_id: tenant.organizationId,
  project_id: tenant.projectId,
});
