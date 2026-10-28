export const PASSWORD_RULES = Object.freeze([
  'repeated_character',
  'sequence',
  'keyboard_walk',
  'repeated_unit',
  'context',
] as const);

export type PasswordRule = (typeof PASSWORD_RULES)[number];

export interface PasswordContext {
  readonly email?: string;
  readonly organizationName?: string;
  readonly organizationSlug?: string;
}

// Rows of QWERTY, AZERTY and QWERTZ. The digit row is shared.
export const KEYBOARD_ROWS = Object.freeze([
  '1234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'azertyuiop',
  'qsdfghjklm',
  'wxcvbn',
  'qwertzuiop',
  'yxcvbnm',
]);

const RUN = 6;
const MAX_UNIT = 4;
// Shorter terms would refuse a large share of random passwords by chance.
const MIN_TERM = 3;

const reverse = (s: string) => Array.from(s).reverse().join('');

// Every run of six adjacent keys along a row, either way. Built once.
const WALKS: ReadonlySet<string> = new Set(
  KEYBOARD_ROWS.flatMap((row) =>
    [row, reverse(row)].flatMap((r) =>
      Array.from({ length: r.length - RUN + 1 }, (_, i) => r.slice(i, i + RUN)),
    ),
  ),
);

const fold = (s: string) => s.normalize('NFKC').toLowerCase();
const compact = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, '');

const isLetter = (c: number) => c >= 0x61 && c <= 0x7a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function hasSequence(s: string): boolean {
  let up = 1;
  let down = 1;
  for (let i = 1; i < s.length; i += 1) {
    const a = s.charCodeAt(i - 1);
    const b = s.charCodeAt(i);
    const same = (isLetter(a) && isLetter(b)) || (isDigit(a) && isDigit(b));
    up = same && b - a === 1 ? up + 1 : 1;
    down = same && a - b === 1 ? down + 1 : 1;
    if (up >= RUN || down >= RUN) return true;
  }
  return false;
}

function hasWalk(s: string): boolean {
  for (let i = 0; i + RUN <= s.length; i += 1) {
    if (WALKS.has(s.slice(i, i + RUN))) return true;
  }
  return false;
}

// The whole password is a unit of up to four characters repeated, a partial last copy
// included ("abcabcab").
function repeatedUnit(points: readonly string[]): boolean {
  for (let unit = 1; unit <= MAX_UNIT; unit += 1) {
    if (points.length < unit * 2) continue;
    if (points.every((c, i) => i < unit || c === points[i - unit])) return true;
  }
  return false;
}

function contextTerms(context: PasswordContext): string[] {
  const terms = ['drefyn'];
  const email = context.email ?? '';
  const at = email.lastIndexOf('@');
  if (at > 0) terms.push(email.slice(0, at), email.slice(at + 1).split('.')[0] ?? '');
  if (context.organizationName !== undefined) terms.push(context.organizationName);
  if (context.organizationSlug !== undefined) terms.push(context.organizationSlug);
  return terms.map(compact).filter((term) => term.length >= MIN_TERM);
}

// The built in rules that refuse a password, in PASSWORD_RULES order; empty when none
// does. Case, width and punctuation are folded first, so "QWERTY" and "a-c-m-e" count.
export function checkCommonPassword(
  password: string,
  context: PasswordContext = {},
): readonly PasswordRule[] {
  const folded = fold(password);
  const points = Array.from(folded);
  const squeezed = compact(password);
  const refused: PasswordRule[] = [];
  if (points.length > 0 && points.every((c) => c === points[0])) refused.push('repeated_character');
  if (hasSequence(folded)) refused.push('sequence');
  if (hasWalk(folded)) refused.push('keyboard_walk');
  if (repeatedUnit(points)) refused.push('repeated_unit');
  if (contextTerms(context).some((term) => squeezed.includes(term))) refused.push('context');
  return Object.freeze(refused);
}
