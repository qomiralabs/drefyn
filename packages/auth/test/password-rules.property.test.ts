import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_ROWS,
  PASSWORD_RULES,
  checkCommonPassword,
  type PasswordContext,
  type PasswordRule,
} from '../src/index.ts';
import { runs } from './support.ts';

// The rows written out again, so an edit to the package list has to be made twice.
const ROWS = [
  '1234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'azertyuiop',
  'qsdfghjklm',
  'wxcvbn',
  'qwertzuiop',
  'yxcvbnm',
];

// Naive oracles, one per rule, written for clarity rather than speed.
const fold = (s: string) => s.normalize('NFKC').toLowerCase();
const compact = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, '');

const oracle: Record<PasswordRule, (password: string, context: PasswordContext) => boolean> = {
  repeated_character: (p) => {
    const s = Array.from(fold(p));
    return s.length > 0 && s.every((c) => c === s[0]);
  },
  sequence: (p) => {
    const s = fold(p);
    for (let i = 0; i + 6 <= s.length; i += 1) {
      const run = s.slice(i, i + 6);
      for (const step of [1, -1]) {
        let ok = true;
        for (let j = 1; j < 6; j += 1) {
          const a = run.charCodeAt(j - 1);
          const b = run.charCodeAt(j);
          const sameClass =
            (/[a-z]/.test(run.charAt(j - 1)) && /[a-z]/.test(run.charAt(j))) ||
            (/[0-9]/.test(run.charAt(j - 1)) && /[0-9]/.test(run.charAt(j)));
          if (!sameClass || b - a !== step) ok = false;
        }
        if (ok) return true;
      }
    }
    return false;
  },
  keyboard_walk: (p) => {
    const s = fold(p);
    for (let i = 0; i + 6 <= s.length; i += 1) {
      const run = s.slice(i, i + 6);
      if (
        ROWS.some((row) => row.includes(run) || Array.from(row).reverse().join('').includes(run))
      ) {
        return true;
      }
    }
    return false;
  },
  repeated_unit: (p) => {
    const s = Array.from(fold(p));
    for (let unit = 1; unit <= 4; unit += 1) {
      if (s.length < unit * 2) continue;
      if (s.every((c, i) => i < unit || c === s[i - unit])) return true;
    }
    return false;
  },
  context: (p, context) => {
    const terms = ['drefyn'];
    const email = context.email ?? '';
    const at = email.lastIndexOf('@');
    if (at > 0) {
      terms.push(email.slice(0, at), email.slice(at + 1).split('.')[0] ?? '');
    }
    if (context.organizationName !== undefined) terms.push(context.organizationName);
    if (context.organizationSlug !== undefined) terms.push(context.organizationSlug);
    return terms
      .map(compact)
      .filter((t) => t.length >= 3)
      .some((t) => compact(p).includes(t));
  },
};

const expected = (password: string, context: PasswordContext = {}) =>
  PASSWORD_RULES.filter((rule) => oracle[rule](password, context));

const randomCase = (s: string) =>
  fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((flags) =>
    Array.from(s)
      .map((c, i) => (flags[i] === true ? c.toUpperCase() : c))
      .join(''),
  );

const pad = fc.string({
  unit: fc.constantFrom(...Array.from('!#%&*+=?^~ 2468ACEGIKMOQSUW')),
  maxLength: 12,
});
const embed = (core: fc.Arbitrary<string>) =>
  fc.tuple(pad, core.chain(randomCase), pad).map(([a, b, c]) => a + b + c);

const families: Record<
  PasswordRule,
  fc.Arbitrary<{ password: string; context: PasswordContext }>
> = {
  repeated_character: fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 1, unit: 'grapheme-ascii' }),
      fc.integer({ min: 15, max: 64 }),
    )
    .map(([c, n]) => ({ password: c.repeat(n), context: {} })),
  sequence: embed(
    fc
      .tuple(
        fc.constantFrom('abcdefghijklmnopqrstuvwxyz', '0123456789'),
        fc.boolean(),
        fc.integer({ min: 6, max: 10 }),
        fc.nat(),
      )
      .map(([alphabet, down, n, at]) => {
        const run = down ? Array.from(alphabet).reverse().join('') : alphabet;
        const start = at % (run.length - n + 1);
        return run.slice(start, start + n);
      }),
  ).map((password) => ({ password, context: {} })),
  keyboard_walk: embed(
    fc
      .tuple(
        fc.constantFrom(...ROWS.slice(1)),
        fc.boolean(),
        fc.integer({ min: 6, max: 10 }),
        fc.nat(),
      )
      .filter(([row, , n]) => n <= row.length)
      .map(([row, back, n, at]) => {
        const r = back ? Array.from(row).reverse().join('') : row;
        const start = at % (r.length - n + 1);
        return r.slice(start, start + n);
      }),
  ).map((password) => ({ password, context: {} })),
  repeated_unit: fc
    .tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.integer({ min: 15, max: 64 }))
    .filter(([unit]) => unit.length > 0 && fold(unit).length === unit.length)
    .map(([unit, n]) => ({
      password: unit.repeat(n).slice(0, Math.max(n, unit.length * 2)),
      context: {},
    })),
  context: fc
    .tuple(
      fc.stringMatching(/^[a-z]{3,10}$/),
      fc.stringMatching(/^[a-z]{3,10}$/),
      fc.stringMatching(/^[a-z]{3,10}( [a-z]{3,8})?$/),
      fc.constantFrom('local', 'domain', 'name', 'slug', 'product'),
    )
    .chain(([user, host, org, which]) => {
      const context: PasswordContext = {
        email: `${user}@${host}.example`,
        organizationName: org,
        organizationSlug: org.replace(' ', '-'),
      };
      const term = {
        local: user,
        domain: host,
        name: org,
        slug: org.replace(' ', '-'),
        product: 'drefyn',
      }[which];
      return embed(fc.constant(term)).map((password) => ({ password, context }));
    }),
};

describe('checkCommonPassword', () => {
  it('names the five rules in a fixed order', () => {
    expect(PASSWORD_RULES).toEqual([
      'repeated_character',
      'sequence',
      'keyboard_walk',
      'repeated_unit',
      'context',
    ]);
    expect(KEYBOARD_ROWS).toEqual(ROWS);
  });

  for (const rule of PASSWORD_RULES) {
    it(`refuses the ${rule} family`, () => {
      fc.assert(
        fc.property(families[rule], ({ password, context }) => {
          expect(checkCommonPassword(password, context)).toContain(rule);
        }),
        runs,
      );
    });
  }

  it('accepts random passwords of 15 or more characters outside every family', () => {
    const random = fc.string({ minLength: 15, maxLength: 48, unit: 'grapheme-ascii' });
    fc.assert(
      fc.property(random, (password) => {
        fc.pre(expected(password).length === 0);
        expect(checkCommonPassword(password)).toEqual([]);
      }),
      { ...runs, numRuns: 2000 },
    );
  });

  it('agrees with the naive oracles on random and near miss input', () => {
    const nearMiss = fc.oneof(
      fc.string({ minLength: 15, maxLength: 40, unit: 'grapheme-ascii' }),
      fc.string({
        minLength: 15,
        maxLength: 40,
        unit: fc.constantFrom(...Array.from('abcdefqwertyasdfgzxcvb123456')),
      }),
      ...PASSWORD_RULES.map((rule) => families[rule].map(({ password }) => password)),
    );
    const context = fc.record(
      {
        email: fc.constantFrom('jo@ab.example', 'jane.doe@acme.example', 'x@y'),
        organizationName: fc.constantFrom('Acme Widgets', 'Q', 'drefyn'),
        organizationSlug: fc.constantFrom('acme-widgets', 'qq', 'river'),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(nearMiss, context, (password, ctx) => {
        expect(checkCommonPassword(password, ctx)).toEqual(expected(password, ctx));
      }),
      { ...runs, numRuns: 2000 },
    );
  });

  it('accepts real passphrases that only look loose', () => {
    for (const passphrase of [
      'correct horse battery staple',
      'purple-otter-lantern-29',
      'my cat likes warm windowsills',
      'quiet river under maple trees',
      'typewriter ribbons are rare now',
      'Pour mon ami, le chat noir 7',
      'Zwei Kaffee und ein Stueck Kuchen',
      'xylophone quartz jukebox vivid',
      'Tolle Fruehlingswiese am Bach!',
      'seventy seven swans swimming',
    ]) {
      expect(checkCommonPassword(passphrase, { email: 'jane@acme.example' })).toEqual([]);
    }
  });

  it('folds width and case before matching, so full width and upper case runs still count', () => {
    expect(checkCommonPassword('\uff41\uff42\uff43\uff44\uff45\uff46 is my password')).toContain(
      'sequence',
    );
    expect(checkCommonPassword('Mon mot AZERTY: azertyu plus')).toContain('keyboard_walk');
    expect(checkCommonPassword('QWERTZUIOP and more letters')).toContain('keyboard_walk');
    expect(checkCommonPassword('the WXCVBN row is a walk too')).toContain('keyboard_walk');
  });

  it('matches context terms ignoring spaces and punctuation, and skips terms under 3 characters', () => {
    const context = {
      email: 'jo@ab.example',
      organizationName: 'Acme Widgets',
      organizationSlug: 'acme-widgets',
    };
    expect(checkCommonPassword('I love ACME-widgets so much', context)).toContain('context');
    expect(checkCommonPassword('jo and ab are short names!', context)).toEqual([]);
    expect(
      checkCommonPassword('my exampledomain password', { email: 'jane@example.com' }),
    ).toContain('context');
    expect(checkCommonPassword('D.r.e.f.y.n forever and ever')).toContain('context');
  });
});
