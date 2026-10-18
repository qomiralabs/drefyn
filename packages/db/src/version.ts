import { notImplemented } from './not-implemented.ts';

// Lowest pgvector managed Postgres ships on the supported major.
export const VECTOR_VERSION_FLOOR = '0.8.2';

export type Version = readonly [major: number, minor: number, patch: number];

// Strict major.minor.patch; anything else is undefined.
export function parseVersion(value: string): Version | undefined {
  return notImplemented('parseVersion', value);
}

// Numeric, part by part. Throws on a value parseVersion rejects.
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return notImplemented('compareVersions', a, b);
}

// False for a malformed version, so an unreadable extversion never passes.
export function meetsVersionFloor(version: string, floor: string = VECTOR_VERSION_FLOOR): boolean {
  return notImplemented('meetsVersionFloor', version, floor);
}
