import { z } from 'zod';
import { PATH_MAX_CHARS } from './folder.ts';

// GitHub logins: letters, digits and single hyphens, up to 39 characters.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
// A full SHA-1 or SHA-256 object id, lower case as the API returns it.
export const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// GitHub delivery GUIDs and our reconcile ids. Kept to characters safe in a log line.
export const DELIVERY_ID = /^[A-Za-z0-9:._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;

// The rules of git check-ref-format for one branch name, so a binding never names a ref the
// API would refuse or read as something else.
export function isBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name === '@') return false;
  if (REF_FORBIDDEN.test(name) || name.includes('..') || name.includes('@{')) return false;
  if (name.startsWith('-') || name.endsWith('.')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const uuid = z.string().regex(UUID);

export const bindingInputSchema = z.strictObject({
  installationId: positiveId,
  repository: z.strictObject({
    owner: z.string().regex(OWNER),
    name: z
      .string()
      .regex(REPOSITORY)
      .refine((name) => name !== '.' && name !== '..'),
    id: positiveId,
  }),
  branch: z.string().refine(isBranchName),
  // Checked by parseFolder, which has its own stable code.
  folder: z.unknown(),
});

export type BindingInput = z.input<typeof bindingInputSchema>;

export const fileEntrySchema = z.strictObject({
  path: z.string().min(1).max(PATH_MAX_CHARS),
  nodeId: uuid,
  blobSha: z.string().regex(SHA),
  syncedVersionId: uuid,
});

export const deliveryInputSchema = z.strictObject({
  bindingId: uuid,
  deliveryId: z.string().regex(DELIVERY_ID),
  headSha: z.string().regex(SHA).nullable(),
});

export type DeliveryInput = z.input<typeof deliveryInputSchema>;

export const stateCodeSchema = z
  .string()
  .max(63)
  .regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
