import fc from 'fast-check';
import { idOf, ID_KINDS, type IdKind } from '@drefyn/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../src/new-id.ts';
import { thrown } from './support.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The first 48 bits of a UUIDv7 are the Unix time in milliseconds.
function timestampOf(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('newId', () => {
  it.each(ID_KINDS)('gives a canonical lowercase UUIDv7 for %s', (kind) => {
    const id = newId(kind);
    expect(id).toMatch(UUID_V7);
    // The tenancy validator accepts it unchanged, so it can go straight into a TenantRef.
    expect(idOf(kind, id)).toBe(id);
  });

  it('carries the clock time in its first 48 bits', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    expect(timestampOf(newId('org'))).toBe(Date.parse('2026-10-26T12:00:00.000Z'));
    vi.setSystemTime(new Date('2030-01-01T00:00:00.123Z'));
    expect(timestampOf(newId('prj'))).toBe(Date.parse('2030-01-01T00:00:00.123Z'));
  });

  // Ids made later in one process sort later, which keeps index inserts at the right edge.
  // After a step back the first 48 bits hold the last timestamp used, not the clock.
  it('increases strictly within one millisecond and across a clock step back', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) ids.push(newId('nod'));
    vi.setSystemTime(new Date('2026-10-26T11:59:59.000Z'));
    for (let i = 0; i < 10; i += 1) ids.push(newId('nod'));
    expect(timestampOf(ids.at(-1) ?? '')).toBeGreaterThanOrEqual(
      Date.parse('2026-10-26T12:00:00.000Z'),
    );
    for (let i = 1; i < ids.length; i += 1) {
      expect((ids[i] ?? '') > (ids[i - 1] ?? ''), `id ${String(i)}`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never repeats over many calls with a moving fake clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 200 }),
        (steps) => {
          vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
          const seen = new Set<string>();
          for (const step of steps) {
            vi.advanceTimersByTime(step);
            const id = newId('evt');
            if (seen.has(id) || !UUID_V7.test(id)) return false;
            seen.add(id);
          }
          return true;
        },
      ),
      { seed: 20261026, numRuns: 100 },
    );
  });

  it('refuses an unknown kind', () => {
    const error = thrown(() => newId('nope' as IdKind));
    expect((error as { code?: string }).code).toBe('ID_KIND_UNKNOWN');
  });
});
