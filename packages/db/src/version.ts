// Lowest pgvector managed Postgres ships on the supported major.
export const VECTOR_VERSION_FLOOR = '0.8.2';

export type Version = readonly [major: number, minor: number, patch: number];

// No leading zeros, so each version has one spelling and "0.08.2" cannot sneak past.
const PART = '(0|[1-9][0-9]*)';
const STRICT = new RegExp(`^${PART}\\.${PART}\\.${PART}$`);

// Strict major.minor.patch; anything else is undefined.
export function parseVersion(value: string): Version | undefined {
  const match = STRICT.exec(value);
  if (match === null) return undefined;
  const parts = [match[1], match[2], match[3]].map(Number);
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  // A part past 2^53 would compare wrongly once rounded.
  if (!parts.every((part) => Number.isSafeInteger(part))) return undefined;
  return [major, minor, patch];
}

function parseOrThrow(value: string): Version {
  const parsed = parseVersion(value);
  if (parsed === undefined) {
    throw new Error(`not a major.minor.patch version: ${JSON.stringify(value)}`);
  }
  return parsed;
}

// Numeric, part by part. Throws on a value parseVersion rejects.
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseOrThrow(a);
  const right = parseOrThrow(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// False for a malformed version, so an unreadable extversion never passes.
export function meetsVersionFloor(version: string, floor: string = VECTOR_VERSION_FLOOR): boolean {
  if (parseVersion(version) === undefined) return false;
  return compareVersions(version, floor) >= 0;
}
