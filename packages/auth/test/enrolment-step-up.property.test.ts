import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENROLMENT_STEP_UP_MINUTES,
  SETTLED_PASSWORD_HOURS,
  enrolmentStepUpPasses,
} from '../src/enrolment-step-up.ts';
import { runs } from './support.ts';

const DAY = SETTLED_PASSWORD_HOURS * 60;

describe('enrolmentStepUpPasses', () => {
  it.each([
    [{ method: null, fresh: true, passwordSettled: true }, false],
    [{ method: 'email', fresh: false, passwordSettled: null }, false],
    [{ method: 'email', fresh: true, passwordSettled: null }, true],
    [{ method: 'email', fresh: true, passwordSettled: false }, true],
    [{ method: 'google', fresh: true, passwordSettled: false }, true],
    [{ method: 'github_session', fresh: true, passwordSettled: null }, true],
    [{ method: 'totp', fresh: true, passwordSettled: null }, true],
    [{ method: 'recovery_code', fresh: true, passwordSettled: null }, true],
    [{ method: 'password', fresh: true, passwordSettled: true }, true],
    [{ method: 'password', fresh: true, passwordSettled: false }, false],
    [{ method: 'password', fresh: true, passwordSettled: null }, false],
    [{ method: 'password', fresh: false, passwordSettled: true }, false],
    [{ method: 'sms', fresh: true, passwordSettled: true }, false],
  ])('%j passes: %s', (proof, expected) => {
    expect(enrolmentStepUpPasses(proof)).toBe(expected);
  });
});

// A thief holding only a cookie from a fresh sign in: no mailbox, no provider account and
// not the owner's password. What it can do is set a password of its own (recent auth
// allows that), step up with it, and wait.
type Move =
  | { readonly kind: 'set_password' }
  | { readonly kind: 'step_up_password' }
  | { readonly kind: 'wait'; readonly minutes: number };

const move: fc.Arbitrary<Move> = fc.oneof(
  fc.constant<Move>({ kind: 'set_password' }),
  fc.constant<Move>({ kind: 'step_up_password' }),
  fc.integer({ min: 0, max: 8 * 60 }).map((minutes): Move => ({ kind: 'wait', minutes })),
);

interface World {
  now: number;
  // When the thief last wrote the password, in minutes; null before it ever does.
  passwordWrittenAt: number | null;
  stepUpAt: number | null;
}

function play(moves: readonly Move[]): World {
  const world: World = { now: 0, passwordWrittenAt: null, stepUpAt: null };
  for (const m of moves) {
    if (m.kind === 'wait') world.now += m.minutes;
    else if (m.kind === 'set_password') world.passwordWrittenAt = world.now;
    // It only knows a password it chose.
    else if (world.passwordWrittenAt !== null) world.stepUpAt = world.now;
  }
  return world;
}

function proofOf(world: World) {
  return {
    method: world.stepUpAt === null ? null : 'password',
    fresh: world.stepUpAt !== null && world.now - world.stepUpAt < ENROLMENT_STEP_UP_MINUTES,
    passwordSettled:
      world.passwordWrittenAt === null ? null : world.now - world.passwordWrittenAt >= DAY,
  };
}

describe('a proof the session made for itself', () => {
  it('never passes while the password it chose is under a day old', () => {
    fc.assert(
      fc.property(fc.array(move, { maxLength: 30 }), (moves) => {
        const world = play(moves);
        fc.pre(world.passwordWrittenAt === null || world.now - world.passwordWrittenAt < DAY);
        expect(enrolmentStepUpPasses(proofOf(world))).toBe(false);
      }),
      runs,
    );
  });

  it('passes only after the password has stood a day and the step up is fresh', () => {
    fc.assert(
      fc.property(fc.array(move, { maxLength: 30 }), (moves) => {
        const world = play(moves);
        const passes = enrolmentStepUpPasses(proofOf(world));
        const settled =
          world.passwordWrittenAt !== null && world.now - world.passwordWrittenAt >= DAY;
        const fresh =
          world.stepUpAt !== null && world.now - world.stepUpAt < ENROLMENT_STEP_UP_MINUTES;
        expect(passes).toBe(settled && fresh);
      }),
      runs,
    );
  });
});
