import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The address on a user row is what invitations, linking and sign in trust. Sign up writes
// it once (by email code, or by a provider that verified it) and the proved change flow
// moves it; any other write in this package is a way to point an account at an address
// nobody proved.
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'email-sign-in.ts': ['insert'],
  'email-change.ts': ['update'],
  'oauth.ts': ['insert'],
  // The operator's sign up: the address the person running the box vouches for.
  'cli-links.ts': ['insert'],
};

const QUOTED_TABLE = String.raw`\(\s*(['"\x60])(?:app\.)?users(?:\s+as\s+\w+)?\1\s*\)`;
const BUILDER: readonly (readonly [string, RegExp])[] = [
  ['insert', new RegExp(`\\binsertInto${QUOTED_TABLE}`, 'g')],
  ['update', new RegExp(`\\bupdateTable${QUOTED_TABLE}`, 'g')],
  ['merge', new RegExp(`\\bmergeInto${QUOTED_TABLE}`, 'g')],
  ['replace', new RegExp(`\\breplaceInto${QUOTED_TABLE}`, 'g')],
];
const RAW = /\b(insert\s+into|update|merge\s+into)\s+(?:"?app"?\s*\.\s*)?"?users"?(?![\w"])/gi;

function addressWrites(source: string): string[] {
  const found: string[] = [];
  for (const [kind, pattern] of BUILDER) {
    found.push(...Array.from(source.matchAll(pattern), () => kind));
  }
  for (const match of source.matchAll(RAW)) {
    const verb = (match[1] ?? '').toLowerCase();
    found.push(
      verb.startsWith('insert') ? 'insert' : verb.startsWith('merge') ? 'merge' : 'update',
    );
  }
  return found.sort();
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const SRC = join(import.meta.dirname, '..', 'src');

describe('writes of the user address', () => {
  it('come only from sign up and the proved change flow', () => {
    const seen: Record<string, string[]> = {};
    for (const path of sources(SRC)) {
      const writes = addressWrites(readFileSync(path, 'utf8'));
      if (writes.length > 0) seen[relative(SRC, path)] = writes;
    }
    expect(seen).toEqual(ALLOWED);
  });

  const quote = fc.constantFrom("'", '"', '`');
  const gap = fc.stringMatching(/^[ \n\t]{0,3}$/);
  const schema = fc.constantFrom('', 'app.');
  const alias = fc.constantFrom('', ' as u', ' as users');

  it('the check sees a builder write however it is spelled', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('insertInto', 'updateTable', 'mergeInto', 'replaceInto'),
        quote,
        gap,
        gap,
        schema,
        alias,
        (method, q, before, after, prefix, as) => {
          const source = `await tx.${method}(${before}${q}${prefix}users${as}${q}${after})`;
          expect(addressWrites(source)).toHaveLength(1);
        },
      ),
    );
  });

  it('the check sees a raw SQL write however it is spelled', () => {
    const casing = (word: string) =>
      fc
        .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
        .map((upper) =>
          word.replace(/[a-z]/g, (ch: string, i: number) =>
            upper[i] === true ? ch.toUpperCase() : ch,
          ),
        );
    fc.assert(
      fc.property(
        fc.oneof(casing('insert into'), casing('update'), casing('merge into')),
        fc.stringMatching(/^[ \n\t]{1,3}$/),
        fc.constantFrom('users', '"users"', 'app.users', 'app."users"', '"app"."users"'),
        fc.constantFrom(' set', '\n(', ' u', ''),
        (verb, space, table, rest) => {
          const source = `sql\`${verb.replace(' ', space)}${space}${table}${rest} ...\``;
          expect(addressWrites(source)).toHaveLength(1);
        },
      ),
    );
  });

  it('the check leaves other tables alone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('sessions', 'users_audit', 'email_challenges', 'identities', 'superusers'),
        quote,
        (table, q) => {
          const source = `tx.updateTable(${q}${table}${q}); tx.insertInto(${q}${table}${q}); sql\`update ${table} set x = 1\``;
          expect(addressWrites(source)).toEqual([]);
        },
      ),
    );
  });
});
