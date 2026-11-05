import type { StepUpFacts } from './models.ts';

// What a settings action answers. Plain data, so it crosses the server boundary as it is.
export type Problem =
  // The person must confirm it is them, then the same call runs again.
  | { readonly kind: 'step_up' }
  | { readonly kind: 'limited'; readonly minutes: number }
  // Our failure, with the line in the log it ties to.
  | { readonly kind: 'failed'; readonly reference: string }
  // A rule said no, by its code, and the screen has the words for it.
  | { readonly kind: 'refused'; readonly code: string };

export type Outcome<T = undefined> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };

interface Refusal {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
}

// The wrappers answer a refused request as a value of their own shape.
export function settle<T>(answer: Outcome<T> | Refusal): Outcome<T> {
  if ('status' in answer) {
    return { ok: false, problem: { kind: 'failed', reference: answer.code } };
  }
  return answer;
}

// The words for a failure a screen has no special case for.
export function problemWords(problem: Problem): string {
  switch (problem.kind) {
    case 'step_up':
      return 'That needs you to confirm it is you.';
    case 'limited':
      return `Too many tries. You can try again in ${String(problem.minutes)} ${
        problem.minutes === 1 ? 'minute' : 'minutes'
      }.`;
    case 'failed':
      return `That did not work, and nothing changed. Try again. Reference ${problem.reference}.`;
    case 'refused':
      return problem.code === 'AUTH_SESSION_INVALID'
        ? 'Your session has ended. Sign in again.'
        : 'You cannot do that here.';
  }
}

export interface StepUpChoices extends StepUpFacts {
  readonly address: string;
  readonly lastSignIn: string;
}

export interface InviteResult {
  readonly email: string;
  readonly result: 'sent' | 'member' | 'blocked' | 'limit' | 'invalid' | 'failed' | 'waiting';
}

export interface KeyToRevoke {
  readonly keyId: string;
  readonly name: string;
  readonly suffix: string;
  readonly lastUsedAt: string | null;
}

export interface MadeKey {
  readonly name: string;
  readonly secret: string;
  readonly scopes: readonly string[];
  readonly projectScope: 'all' | 'listed';
  readonly projectIds: readonly string[];
  readonly expiresAt: string | null;
}
