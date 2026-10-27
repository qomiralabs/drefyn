import { organizationId, projectId } from '@drefyn/tenancy';
import { DbError } from './errors.ts';

export interface TenantSettings {
  readonly organizationId: string;
  // Empty for an organization scoped transaction, so the project always gets set too.
  readonly projectId: string;
}

function missing(reason: string): DbError {
  return new DbError('DB_TENANT_CONTEXT_MISSING', `tenant context ${reason}`);
}

function canonical(value: unknown, parse: (text: string) => string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parse(value);
  } catch {
    return undefined;
  }
}

// Validates a context at run time, because a cast or an untyped caller can get past the
// branded types. Throws DbError DB_TENANT_CONTEXT_MISSING.
export function tenantSettings(ctx: unknown, scope: 'organization' | 'project'): TenantSettings {
  if (typeof ctx !== 'object' || ctx === null) throw missing('is not an object');
  // Each id is read exactly once, so a getter cannot pass the check and then change.
  const rawOrganization: unknown = Reflect.get(ctx, 'organizationId');
  const hasProject = 'projectId' in ctx;
  const rawProject: unknown = hasProject ? Reflect.get(ctx, 'projectId') : undefined;
  const organization = canonical(rawOrganization, organizationId);
  if (organization === undefined) throw missing('has no valid organizationId');
  if (rawProject === undefined) {
    if (scope === 'project') throw missing('needs a projectId here');
    return { organizationId: organization, projectId: '' };
  }
  // An empty or malformed project must never widen a project transaction to the whole
  // organization.
  const project = canonical(rawProject, projectId);
  if (project === undefined) throw missing('has an invalid projectId');
  return { organizationId: organization, projectId: project };
}

// Ceilings per pool: an unbounded value would quietly turn the timeout off.
export const APP_TIMEOUT_MAX_MS = 60_000;
export const READER_TIMEOUT_MAX_MS = 10_000;

// The statement timeout for one transaction. Throws DbError DB_CONFIG_INVALID.
export function transactionTimeout(timeoutMs: unknown, fallbackMs: number, maxMs: number): number {
  const value = timeoutMs === undefined ? fallbackMs : timeoutMs;
  // Zero is no timeout to Postgres, which turns a bounded failure into a hang.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maxMs) {
    throw new DbError(
      'DB_CONFIG_INVALID',
      `timeoutMs must be a whole number of milliseconds from 1 to ${String(maxMs)}`,
    );
  }
  return value;
}
