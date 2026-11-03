import { z } from 'zod';
import { AuthError } from './errors.ts';
import { checkCommonPassword, type PasswordContext, type PasswordRule } from './password-rules.ts';

// Checked on raw bytes before anything else runs, so an oversized body never reaches the
// parser and an oversized field never reaches NFKC, which can grow text many times over.
export const PASSWORD_FORM_MAX_BYTES = 8 * 1024;
export const PASSWORD_RAW_MAX_BYTES = 4 * 1024;
// What the hash ever sees, after NFKC.
export const PASSWORD_MAX_BYTES = 1024;
export const PASSWORD_MIN_CHARACTERS = 15;
export const PASSWORD_MAX_CHARACTERS = 128;

export type WeakPasswordRule = 'too_short' | 'too_long' | PasswordRule;

const invalid = () => new AuthError('AUTH_INPUT_INVALID');

// The password as hashed: NFKC, so the same password typed on two keyboards hashes the same.
// Throws AUTH_INPUT_INVALID past either byte cap or on a lone surrogate, which has no bytes
// two browsers would agree on.
export function normalizePassword(raw: string): string {
  if (
    raw.length > PASSWORD_RAW_MAX_BYTES ||
    Buffer.byteLength(raw, 'utf8') > PASSWORD_RAW_MAX_BYTES
  ) {
    throw invalid();
  }
  if (!raw.isWellFormed()) throw invalid();
  const normalized = raw.normalize('NFKC');
  if (Buffer.byteLength(normalized, 'utf8') > PASSWORD_MAX_BYTES) throw invalid();
  return normalized;
}

// The rules a new password breaks, length first and then the built in common password
// rules; empty when it may be used. Expects a password already through normalizePassword.
export function checkNewPassword(
  password: string,
  context: PasswordContext,
): readonly WeakPasswordRule[] {
  const normalized = password.normalize('NFKC');
  const characters = Array.from(normalized).length;
  const refused: WeakPasswordRule[] = [];
  if (characters < PASSWORD_MIN_CHARACTERS) refused.push('too_short');
  if (characters > PASSWORD_MAX_CHARACTERS) refused.push('too_long');
  refused.push(...checkCommonPassword(normalized, context));
  return Object.freeze(refused);
}

export interface PasswordSignInForm {
  readonly email: string;
  readonly password: string;
  readonly csrf: string;
  readonly returnTo?: string;
  readonly botToken?: string;
}

const FIELDS = ['email', 'password', 'csrf', 'returnTo', 'botToken'] as const;

const formSchema = z.object({
  email: z.string().min(3).max(254),
  password: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_RAW_MAX_BYTES),
  csrf: z.string().min(1).max(128),
  returnTo: z.string().max(2048).optional(),
  botToken: z.string().max(2048).optional(),
});

// The password form as posted (application/x-www-form-urlencoded). Every limit is checked
// before the next step does any work, and a field sent twice is refused rather than one
// copy picked.
export function readPasswordSignInForm(body: string | Uint8Array): PasswordSignInForm {
  const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (size > PASSWORD_FORM_MAX_BYTES) throw invalid();
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  const params = new URLSearchParams(text);
  const fields: Record<string, string> = {};
  for (const name of FIELDS) {
    const values = params.getAll(name);
    if (values.length > 1) throw invalid();
    const value = values[0];
    if (value !== undefined) fields[name] = value;
  }
  const parsed = formSchema.safeParse(fields);
  if (!parsed.success) throw invalid();
  const { returnTo, botToken, ...required } = parsed.data;
  return {
    ...required,
    ...(returnTo === undefined ? {} : { returnTo }),
    ...(botToken === undefined ? {} : { botToken }),
  };
}
