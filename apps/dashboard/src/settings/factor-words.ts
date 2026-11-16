// What the second factor row and its notices say. Pure, so the words are tested once and
// the screens only place them.

// One sentence for a wrong, replayed or spent code, so none can be told from another.
export const FACTOR_WRONG =
  'That code did not work. Use the newest code from your app, or a recovery code you have not used.';
export const FACTOR_PAUSED =
  'Codes from your app are paused after too many wrong tries. Use a recovery code.';

export type FactorFacts =
  | {
      // Enrolment may be offered: a key is configured and the flag is on.
      readonly available: boolean;
      readonly enrolled: boolean;
      readonly recoveryCodesLeft: number;
    }
  | 'failed';

// What the settings page may be told after a refused enrolment route. Closed, so a crafted
// link can only pick one of our sentences.
export const FACTOR_PROBLEM_WORDS = [
  'confirm',
  'wrong',
  'disabled',
  'limited',
  'expired',
  'enrolled',
  'not_enrolled',
  'failed',
] as const;

export type FactorProblem = (typeof FACTOR_PROBLEM_WORDS)[number];

export type FactorNotice =
  | { readonly problem: Exclude<FactorProblem, 'limited' | 'failed'> }
  | { readonly problem: 'limited'; readonly minutes: number }
  | { readonly problem: 'failed'; readonly reference: string | null };

const REFERENCE = /^ref_[0-9a-f]{12}$/;
const MINUTES = /^[1-9][0-9]{0,3}$/;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const isProblem = (value: unknown): value is FactorProblem =>
  typeof value === 'string' && (FACTOR_PROBLEM_WORDS as readonly string[]).includes(value);

// From the query a refused enrolment route sent the person back with. Only exact known
// values show anything, so a crafted link can pick one of our sentences and never its own.
export function factorNoticeFrom(
  query: Readonly<Record<string, string | string[] | undefined>>,
): FactorNotice | null {
  const problem = one(query['factor']);
  if (!isProblem(problem)) return null;
  if (problem === 'limited') {
    const retry = one(query['retry']) ?? '';
    return { problem, minutes: MINUTES.test(retry) ? Number(retry) : 1 };
  }
  if (problem === 'failed') {
    const reference = one(query['ref']) ?? '';
    return { problem, reference: REFERENCE.test(reference) ? reference : null };
  }
  return { problem };
}

const minutesWords = (n: number) => `${String(n)} ${n === 1 ? 'minute' : 'minutes'}`;

export function factorNoticeWords(notice: FactorNotice): readonly [string, string] {
  switch (notice.problem) {
    case 'confirm':
      return [
        'Confirm it is you, then turn it on.',
        'Turning on an authenticator app needs a fresh confirmation every time. A password set or changed in the last day does not count for this, so use an email code or your provider instead.',
      ];
    case 'wrong':
      return [
        'That code did not work.',
        'Nothing changed. Use the newest code from your app, or a recovery code you have not used.',
      ];
    case 'disabled':
      return [
        'Codes from your app are paused.',
        'After too many wrong tries they stop working until a recovery code is used. Nothing changed.',
      ];
    case 'limited':
      return [
        'Too many tries.',
        `You can try again in ${minutesWords(notice.minutes)}. A recovery code still works.`,
      ];
    case 'expired':
      return [
        'That setup ran out of time.',
        'Nothing changed. Turn it on again to get a new code to scan.',
      ];
    case 'enrolled':
      return ['Your authenticator app is already on.', 'Nothing changed.'];
    case 'not_enrolled':
      return ['Your authenticator app is already off.', 'Nothing changed.'];
    case 'failed':
      return [
        'That did not work, and nothing changed.',
        notice.reference === null ? 'Try again.' : `Try again. Reference ${notice.reference}.`,
      ];
  }
}

// The row's sentence, by what is true now.
export function factorDetail(facts: FactorFacts): string {
  if (facts === 'failed') return 'We could not check this just now. Reload the page to try again.';
  if (!facts.enrolled) {
    return 'Off. Once on, signing in also asks for a 6 digit code from an app on your phone.';
  }
  const left = facts.recoveryCodesLeft;
  if (left === 0) return 'On. No recovery codes left, so make new ones now.';
  return `On. ${String(left)} ${left === 1 ? 'recovery code' : 'recovery codes'} left.`;
}

// Shown only where there is something to do: enrolment may be offered, or the person has
// a factor to manage. Turning the flag off never hides a factor someone already has.
export function showFactorRow(facts: FactorFacts | null): boolean {
  if (facts === null) return false;
  return facts === 'failed' || facts.enrolled || facts.available;
}
