import { notImplemented } from './not-implemented.ts';

// Maps a driver error to a DbError where a stable code exists; anything else comes back as
// it was given.
export function toDbError(error: unknown): unknown {
  return notImplemented(`toDbError(${typeof error})`);
}
