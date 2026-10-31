import type * as Crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OTHER_SESSION,
  isProof,
  sessionResponder,
  sessionRow,
  setup,
  tokenFor,
} from './session-fixtures.ts';

// The compare is spied where it lives, so a refactor that swaps it for === fails here.
const compare = vi.hoisted(() => ({ calls: [] as [Uint8Array, Uint8Array][] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compare.calls.push([a as Uint8Array, b as Uint8Array]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

beforeEach(() => {
  compare.calls.splice(0);
});

// Wrong secret, missing row and expired row: the cases where the cookie proves nothing.
const FAILURES = [
  {
    name: 'a wrong secret',
    rows: [sessionRow({ secret: Buffer.alloc(32, 1) })],
    token: tokenFor(),
  },
  { name: 'a missing row', rows: [], token: tokenFor() },
  {
    name: 'a row for another session id',
    rows: [sessionRow()],
    token: tokenFor(undefined, OTHER_SESSION),
  },
  { name: 'an expired row', rows: [sessionRow({ live: false })], token: tokenFor() },
  {
    name: 'an expired row that is also due a touch',
    rows: [sessionRow({ live: false, touch_due: true })],
    token: tokenFor(),
  },
] as const;

describe('the credential first invariant', () => {
  for (const failure of FAILURES) {
    it(`sends exactly one statement and no write for ${failure.name}`, async () => {
      const { sessions, scripted } = setup(sessionResponder(failure.rows));
      await expect(sessions.resolveSession(failure.token)).resolves.toBeNull();
      const statements = scripted.statements();
      expect(statements).toHaveLength(1);
      expect(statements[0] !== undefined && isProof(statements[0])).toBe(true);
      expect(scripted.writes()).toEqual([]);
      expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    });

    it(`the guard half also sends one statement and no write for ${failure.name}`, async () => {
      const { sessions, scripted } = setup(sessionResponder(failure.rows));
      await expect(sessions.resolve(failure.token)).resolves.toBeNull();
      expect(scripted.statements()).toHaveLength(1);
      expect(scripted.writes()).toEqual([]);
    });
  }

  it('selects only the session row by id in the first statement', async () => {
    const { sessions, scripted } = setup();
    await sessions.resolveSession(tokenFor());
    const [first] = scripted.statements();
    expect(first?.sql).toMatch(/from "sessions"/);
    expect(first?.sql).not.toMatch(/join|"users"|"memberships"/i);
    // The id is the only filter: nothing else picks the row.
    expect(first?.sql).toMatch(/ where "id" = \$[0-9]+$/);
  });

  it('reads the address only after the compare matched', async () => {
    const { sessions, scripted } = setup();
    const info = await sessions.resolveSession(tokenFor());
    expect(info?.email).toBe('person@example.com');
    const statements = scripted.statements();
    expect(statements).toHaveLength(2);
    expect(statements[1]?.sql).toMatch(/"users"/);
    expect(scripted.writes()).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  it('never opens a transaction for a value that does not parse', async () => {
    const { sessions, scripted } = setup();
    for (const value of [undefined, '', 'v1.', 'v2.' + tokenFor().slice(3), tokenFor() + 'x']) {
      await expect(sessions.resolveSession(value)).resolves.toBeNull();
    }
    expect(scripted.events).toEqual([]);
  });
});

describe('the compare', () => {
  it('runs timingSafeEqual on the two 32 byte hashes on a hit', async () => {
    const { sessions } = setup();
    await sessions.resolveSession(tokenFor());
    expect(compare.calls).toHaveLength(1);
    const [a, b] = compare.calls[0] ?? [];
    expect(a?.length).toBe(32);
    expect(b?.length).toBe(32);
  });

  it('runs timingSafeEqual against a dummy on a miss', async () => {
    const { sessions } = setup(sessionResponder([]));
    await sessions.resolveSession(tokenFor());
    expect(compare.calls).toHaveLength(1);
    const [a, b] = compare.calls[0] ?? [];
    expect(a?.length).toBe(32);
    expect(b?.length).toBe(32);
  });

  it('runs before the expiry check, so an expired row costs the same compare', async () => {
    const { sessions } = setup(sessionResponder([sessionRow({ live: false })]));
    await sessions.resolveSession(tokenFor());
    expect(compare.calls).toHaveLength(1);
  });
});
