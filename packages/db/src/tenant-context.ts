import { organizationId, projectId, userId } from '@drefyn/tenancy';
import { DbError } from './errors.ts';

// Every transaction sets all four, empty where unused, so nothing left on the session can
// stand in for a value the entry point did not set.
export interface TenantSettings {
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
  // The person acting in organization work. Only restrictive policies read it.
  readonly actorUserId: string;
}

function missing(reason: string): DbError {
  return new DbError('DB_TENANT_CONTEXT_MISSING', `tenant context ${reason}`);
}

function invalid(reason: string): DbError {
  return new DbError('DB_TENANT_CONTEXT_INVALID', `tenant context ${reason}`);
}

function canonical(value: unknown, parse: (text: string) => string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parse(value);
  } catch {
    return undefined;
  }
}

// The own data properties of a plain object. Descriptors never run a getter, so a value
// cannot pass the check and then change, and nothing comes from a prototype.
function ownFields(ctx: unknown, allowed: readonly string[]): Map<string, PropertyDescriptor> {
  if (typeof ctx !== 'object' || ctx === null) throw missing('is not an object');
  const proto: unknown = Object.getPrototypeOf(ctx);
  if (proto !== Object.prototype && proto !== null) throw invalid('is not a plain object');
  const fields = new Map(Object.entries(Object.getOwnPropertyDescriptors(ctx)));
  for (const key of fields.keys()) {
    if (!allowed.includes(key)) throw invalid(`has a field other than ${allowed.join(' and ')}`);
  }
  return fields;
}

function dataValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function organizationOf(fields: Map<string, PropertyDescriptor>): string {
  const organization = canonical(dataValue(fields.get('organizationId')), organizationId);
  if (organization === undefined) throw missing('has no valid organizationId');
  return organization;
}

const FIELDS = ['organizationId', 'projectId'];

// For withTenant and the reader: a project is required. Throws DbError
// DB_TENANT_CONTEXT_MISSING, or DB_TENANT_CONTEXT_INVALID for anything but the two ids.
export function projectSettings(ctx: unknown): TenantSettings {
  const fields = ownFields(ctx, FIELDS);
  const organization = organizationOf(fields);
  const project = canonical(dataValue(fields.get('projectId')), projectId);
  if (project === undefined) throw missing('has no valid projectId');
  return { organizationId: organization, projectId: project, userId: '', actorUserId: '' };
}

// For withOrganization. Any own projectId, even undefined, means the caller holds a project
// context and asked for the wider scope by mistake. An actor, when given, must be a user id:
// an empty or broken one would quietly mean nobody acts.
export function organizationSettings(ctx: unknown): TenantSettings {
  const fields = ownFields(ctx, [...FIELDS, 'actorUserId']);
  if (fields.has('projectId')) throw invalid('has a projectId; use withTenant for a project');
  const organization = organizationOf(fields);
  const descriptor = fields.get('actorUserId');
  let actor = '';
  if (descriptor !== undefined && !('value' in descriptor && descriptor.value === undefined)) {
    const parsed = canonical(dataValue(descriptor), userId);
    if (parsed === undefined) throw invalid('has an actorUserId that is not a valid user id');
    actor = parsed;
  }
  return { organizationId: organization, projectId: '', userId: '', actorUserId: actor };
}

// For withUser. A user belongs to many organizations, so an organization or project key here
// means the caller mixed two contexts, and their permissive policies would combine.
export function userSettings(ctx: unknown): TenantSettings {
  if (typeof ctx === 'object' && ctx !== null) {
    for (const key of ['organizationId', 'projectId']) {
      if (Object.hasOwn(ctx, key)) {
        throw invalid(`has ${key}; a user context holds the user only`);
      }
    }
  }
  const fields = ownFields(ctx, ['userId']);
  const descriptor = fields.get('userId');
  if (descriptor === undefined || ('value' in descriptor && descriptor.value === undefined)) {
    throw missing('has no userId');
  }
  const user = canonical(dataValue(descriptor), userId);
  if (user === undefined) throw invalid('has a userId that is not a valid user id');
  return { organizationId: '', projectId: '', userId: user, actorUserId: '' };
}

// For withAuth: no tenant, no user and no actor, all four set empty.
export const AUTH_SETTINGS: TenantSettings = Object.freeze({
  organizationId: '',
  projectId: '',
  userId: '',
  actorUserId: '',
});

const SETTING = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

// A statement run alone has its settings written into the text rather than bound, so each
// one must be an id or empty by the time it gets there, wherever it came from.
export function assertWritableSettings(settings: TenantSettings): void {
  const values: readonly unknown[] = [
    settings.organizationId,
    settings.projectId,
    settings.userId,
    settings.actorUserId,
  ];
  for (const value of values) {
    if (typeof value !== 'string' || !SETTING.test(value)) {
      throw invalid('has a setting that is not an id');
    }
  }
}

// Ceilings per pool: an unbounded value would quietly turn the timeout off.
export const APP_TIMEOUT_MAX_MS = 60_000;
export const READER_TIMEOUT_MAX_MS = 10_000;
export const AUTH_TIMEOUT_MAX_MS = 10_000;

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
