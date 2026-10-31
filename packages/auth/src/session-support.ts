import type { Result } from '@drefyn/address';
import type { AuthSchema, UserSchema } from '@drefyn/db';
import { idOf, toPublicId, type IdKind, type IdOf, type UserId } from '@drefyn/tenancy';
import type { Transaction } from 'kysely';
import { AuthError } from './errors.ts';
import type { AuthLogger } from './rate-limiter.ts';

export type SessionId = IdOf<'ses'>;
export type SessionMethod = 'email' | 'password' | 'github' | 'google' | 'cli_link';
export type StepUpMethod = 'email' | 'password' | 'google' | 'github_session';

export interface SessionInfo {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly email: string;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
  readonly method: SessionMethod;
  readonly stepUpMethod?: StepUpMethod;
}

// The two transaction kinds sessions use. Tests hand in scripted ones to see every
// statement; the default runs withUser and withAuth.
export interface SessionStore {
  user<T>(userId: UserId, work: (tx: Transaction<UserSchema>) => Promise<T>): Promise<T>;
  auth<T>(work: (tx: Transaction<AuthSchema>) => Promise<T>): Promise<T>;
}

export const unavailable = (error: unknown): AuthError =>
  error instanceof AuthError ? error : new AuthError('AUTH_UNAVAILABLE', { cause: error });

export const ok = <T>(value: T): Result<T, AuthError> => ({ ok: true, value });
export const fail = <T>(error: unknown): Result<T, AuthError> => ({
  ok: false,
  error: unavailable(error),
});

// The id when the value is one, else null: callers hand in ids typed by the compiler, but a
// path that must never throw still checks.
export function asId<K extends IdKind>(kind: K, value: unknown): IdOf<K> | null {
  if (typeof value !== 'string') return null;
  try {
    return idOf(kind, value);
  } catch {
    return null;
  }
}

// Public ids for logs, and nothing for a value that is not an id at all.
export function idFields(
  ids: Readonly<Record<string, readonly [IdKind, unknown]>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, [kind, value]] of Object.entries(ids)) {
    const id = asId(kind, value);
    if (id !== null) out[field] = toPublicId(kind, id);
  }
  return out;
}

export function quietWarn(
  logger: AuthLogger,
  event: string,
  fields: Readonly<Record<string, string>>,
): void {
  try {
    logger.warn(event, fields);
  } catch {
    // A log line is never worth a failed request.
  }
}
