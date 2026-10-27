import { randomFillSync } from 'node:crypto';
import { ID_KINDS, TenancyError, idOf, type IdKind, type IdOf } from '@drefyn/tenancy';

const KINDS: ReadonlySet<string> = new Set(ID_KINDS);
const RANDOM_BITS = 74n;
const RANDOM_LIMIT = 1n << RANDOM_BITS;

// Per process, so ids made later in this process always sort later, even within one
// millisecond or after the clock steps back. That keeps index inserts at the right edge.
let lastMs = -1;
let lastRandom = 0n;

function freshRandom(): bigint {
  const bytes = randomFillSync(new Uint8Array(10));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value & (RANDOM_LIMIT - 1n);
}

// Monotonic random: a new random value when the clock moves on, otherwise the last one plus
// one, and on overflow the next millisecond.
function next(): { ms: number; random: bigint } {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    lastRandom = freshRandom();
  } else {
    lastRandom += 1n;
    if (lastRandom >= RANDOM_LIMIT) {
      lastMs += 1;
      lastRandom = freshRandom();
    }
  }
  return { ms: lastMs, random: lastRandom };
}

function format(ms: number, random: bigint): string {
  const randA = random >> 62n;
  const randB = random & ((1n << 62n) - 1n);
  const bits = (BigInt(ms) << 80n) | (7n << 76n) | (randA << 64n) | (2n << 62n) | randB;
  const hex = bits.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A UUIDv7 for rows whose id is needed before the insert.
export function newId<K extends IdKind>(kind: K): IdOf<K> {
  if (!KINDS.has(kind)) throw new TenancyError('ID_KIND_UNKNOWN');
  const { ms, random } = next();
  return idOf(kind, format(ms, random));
}
