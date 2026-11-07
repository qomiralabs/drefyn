import { idOf, type IdKind, type IdOf } from '@drefyn/tenancy';
import { MAX_RETIRED_FIELDS } from '@drefyn/schema';
import { z } from 'zod';
import type { EngineIssue } from './errors.ts';
import { isOrderKey } from './order-key.ts';
import { NODE_FAMILIES, ORIGINS } from './vocabulary.ts';
import type { Actor } from './types.ts';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const idSchema = <K extends IdKind>(kind: K) =>
  z
    .string()
    .regex(CANONICAL_UUID)
    .transform((value): IdOf<K> => idOf(kind, value));

const nodeId = idSchema('nod');
const versionId = idSchema('ver');

const tenant = z.strictObject({
  organizationId: idSchema('org'),
  projectId: idSchema('prj'),
});

// jsonb refuses a NUL and a lone surrogate, and an answer about bad input beats a database error.
const stored = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0') && value.isWellFormed());

const actor = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    userId: idSchema('usr'),
    roles: z.array(stored(64)).max(32),
  }),
  z.strictObject({
    kind: z.literal('api_key'),
    keyId: stored(64),
    scopes: z.array(stored(64)).max(64),
  }),
  z.strictObject({
    kind: z.literal('git'),
    installationId: stored(64),
    commitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    authorEmail: stored(320),
  }),
  z.strictObject({ kind: z.literal('system'), job: stored(100) }),
]) satisfies z.ZodType<Actor>;

const idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);

const originSchema = z.enum(ORIGINS);

export const createNodeSchema = z.strictObject({
  tenant,
  family: z.enum(NODE_FAMILIES),
  typeId: z.string().regex(CANONICAL_UUID),
  parentId: nodeId.nullish(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,199}$/)
    .nullish(),
  // Absent lands after the last sibling, which is what nearly every caller wants.
  orderKey: z.string().max(64).refine(isOrderKey).optional(),
});

export const moveNodeSchema = z
  .strictObject({ tenant, nodeId, parentId: nodeId.nullable(), afterId: nodeId.nullable() })
  .refine(({ nodeId: id, afterId }) => id !== afterId, { path: ['afterId'] });

// The content is left to the tree check, which can stand a tree of any depth.
export const saveDraftSchema = z.strictObject({
  tenant,
  nodeId,
  expectedHeadVersionId: versionId.nullable(),
  content: z.unknown(),
  origin: originSchema,
  actor,
  idempotencyKey,
  // Absent keeps the head's values, so a client that only edits a body cannot wipe them.
  fields: z.record(z.string().regex(CANONICAL_UUID), z.unknown()).optional(),
});

export const rollbackSchema = z.strictObject({
  tenant,
  nodeId,
  toVersionId: versionId,
  expectedHeadVersionId: versionId,
  actor,
  idempotencyKey,
});

export const readSchema = z.strictObject({ tenant, nodeId });

const MAX_PAGE = 100;
// 256 bytes of control characters grow six times in JSON and a third again in base64.
const MAX_CURSOR_CHARS = 4096;

export const pageSchema = z.strictObject({
  limit: z.int().min(1).max(MAX_PAGE).default(50),
  before: z.int().min(1).optional(),
});

export const querySchema = z.strictObject({
  tenant,
  query: z.strictObject({
    typeId: z.string().regex(CANONICAL_UUID),
    // Shape and field rules are checkFilter's, against the type's own definition.
    filter: z.unknown().optional(),
    sort: z
      .strictObject({
        field: z.string().regex(CANONICAL_UUID),
        direction: z.enum(['asc', 'desc']).default('asc'),
      })
      .optional(),
    limit: z.int().min(1).max(MAX_PAGE).default(50),
    cursor: z.string().min(1).max(MAX_CURSOR_CHARS).optional(),
  }),
});

export const declareSchemaInput = z.strictObject({
  tenant,
  typeId: z.string().regex(CANONICAL_UUID),
  schema: z.unknown(),
  confirmedRemovals: z.array(z.string().regex(CANONICAL_UUID)).max(MAX_RETIRED_FIELDS).optional(),
});

export const backfillInput = z.strictObject({ tenant });

// Keeps the path and a stable code. A zod message can quote the value it refused.
export const issuesOf = (error: z.ZodError): readonly EngineIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
