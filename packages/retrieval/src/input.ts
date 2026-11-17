import { z } from 'zod';

export const LATEST = 'latest';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Code points, so a question in a script outside the basic plane gets the same allowance.
const characters = (value: string) => Array.from(value).length;

const query = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => characters(value) >= 1 && characters(value) <= 512);

// The label column allows 100 characters; named versions add labels without a type change.
const version = z.string().min(1).max(100).default(LATEST);

const path = (max: number) => z.string().startsWith('/').max(max);

const retrieveSchema = z.strictObject({
  query,
  version,
  limit: z.number().int().min(1).max(20).default(8),
  pathPrefix: path(256).optional(),
});

const pageSchema = z.strictObject({
  path: path(2048).optional(),
  nodeId: z.string().regex(CANONICAL_UUID).optional(),
  version,
});

export interface ParsedRetrieve {
  readonly query: string;
  readonly version: string;
  readonly limit: number;
  readonly pathPrefix: string | null;
}

export type PageKey = { readonly path: string } | { readonly nodeId: string };

export interface ParsedPage {
  readonly by: PageKey;
  readonly version: string;
}

// Null for anything the schema refuses, so callers answer one code and never echo the input.
export function parseRetrieveInput(input: unknown): ParsedRetrieve | null {
  const parsed = retrieveSchema.safeParse(input);
  if (!parsed.success) return null;
  const { pathPrefix, ...rest } = parsed.data;
  return { ...rest, pathPrefix: pathPrefix ?? null };
}

export function parsePageInput(input: unknown): ParsedPage | null {
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) return null;
  const { path: pagePath, nodeId, version: label } = parsed.data;
  if (pagePath !== undefined && nodeId === undefined)
    return { by: { path: pagePath }, version: label };
  if (nodeId !== undefined && pagePath === undefined) return { by: { nodeId }, version: label };
  return null;
}
