import fc from 'fast-check';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BREACHED_RECORD_BYTES, openBreachedPasswordFile } from '../src/index.ts';

let dir: string;
let serial = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drefyn-breached-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = fc.uint8Array({
  minLength: BREACHED_RECORD_BYTES,
  maxLength: BREACHED_RECORD_BYTES,
});

// Few distinct leading bytes, so neighbours share long prefixes and the search has to look
// at the last bytes to tell them apart.
const crowded = fc
  .tuple(fc.integer({ min: 0, max: 3 }), record)
  .map(([lead, rest]) => Uint8Array.from([lead, lead, lead, ...rest.slice(3)]));

const anyRecord = fc.oneof(record, crowded);

async function fileOf(records: readonly Uint8Array[]): Promise<string> {
  serial += 1;
  const path = join(dir, `list-${String(serial)}.bin`);
  const sorted = [...records].map((r) => Buffer.from(r)).sort((a, b) => Buffer.compare(a, b));
  await writeFile(path, Buffer.concat(sorted));
  return path;
}

const linear = (records: readonly Uint8Array[], query: Uint8Array) =>
  records.some((r) => Buffer.compare(Buffer.from(r), Buffer.from(query)) === 0);

// One past and one short of a record in the last byte, the closest a miss can be.
function nearMisses(r: Uint8Array): Uint8Array[] {
  const up = Uint8Array.from(r);
  const down = Uint8Array.from(r);
  const last = BREACHED_RECORD_BYTES - 1;
  up[last] = ((r[last] ?? 0) + 1) & 0xff;
  down[last] = ((r[last] ?? 0) + 255) & 0xff;
  return [up, down];
}

describe('the breached list file', () => {
  it('answers every lookup the way a linear scan over the same records does', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyRecord, { maxLength: 300 }),
        fc.array(anyRecord, { maxLength: 20 }),
        fc.integer({ min: 1, max: 9 }),
        async (records, strangers, blockRecords) => {
          const file = await openBreachedPasswordFile(await fileOf(records), { blockRecords });
          try {
            expect(file.records).toBe(records.length);
            const queries = [...records, ...records.flatMap(nearMisses), ...strangers];
            for (const query of queries) {
              await expect(file.contains(query)).resolves.toBe(linear(records, query));
            }
          } finally {
            await file.close();
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('answers every lookup the same with the default block size', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyRecord, { maxLength: 3000 }), async (records) => {
        const file = await openBreachedPasswordFile(await fileOf(records));
        try {
          for (const query of [
            ...records.slice(0, 50),
            ...records.slice(-50).flatMap(nearMisses),
          ]) {
            await expect(file.contains(query)).resolves.toBe(linear(records, query));
          }
        } finally {
          await file.close();
        }
      }),
      { numRuns: 20 },
    );
  });

  it('answers the same for parallel lookups on one handle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyRecord, { minLength: 1, maxLength: 200 }),
        fc.array(anyRecord, { maxLength: 40 }),
        fc.integer({ min: 1, max: 9 }),
        async (records, strangers, blockRecords) => {
          const file = await openBreachedPasswordFile(await fileOf(records), { blockRecords });
          try {
            const queries = [...records, ...strangers];
            const answers = await Promise.all(queries.map((q) => file.contains(q)));
            expect(answers).toEqual(queries.map((q) => linear(records, q)));
          } finally {
            await file.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
