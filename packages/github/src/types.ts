import type { TenantRef } from '@drefyn/tenancy';

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});

export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Ids, codes, counts and timings only. Never a token, a JWT, the key, a secret, a signature
// or anything from a webhook body.
export interface GitHubLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export const noopLogger: GitHubLogger = { info: () => undefined, warn: () => undefined };

export const tenantFields = (tenant: TenantRef): LogFields => ({
  organization_id: tenant.organizationId,
  project_id: tenant.projectId,
});

// GitHub ids are positive integers well inside the safe range.
export const isGitHubId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// What the broker holds of the App key: a way to sign, never the key.
export interface AppSigner {
  sign(data: string): Buffer;
}
