'use client';
import { Button, ButtonLink, Dialog, Skeleton, TextField } from '@drefyn/ui/react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';
import {
  stepUpChoices,
  stepUpSendCode,
  stepUpWithCode,
  stepUpWithFactor,
  stepUpWithPassword,
} from '../server/settings-actions.ts';
import { FACTOR_PAUSED, FACTOR_WRONG } from './factor-words.ts';
import { stepUpWays, type StepUpWay } from './models.ts';
import { problemWords, settle, type StepUpChoices } from './results.ts';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function ageWords(iso: string): string {
  const age = Date.now() - new Date(iso).getTime();
  if (age >= HOUR_MS) {
    const hours = Math.round(age / HOUR_MS);
    return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const minutes = Math.max(1, Math.round(age / MINUTE_MS));
  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
}

type Step =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly words: string }
  | { readonly kind: 'password'; readonly choices: StepUpChoices }
  | { readonly kind: 'code'; readonly choices: StepUpChoices; readonly challenge: string | null }
  | {
      readonly kind: 'factor';
      readonly choices: StepUpChoices;
      readonly code: 'totp' | 'recovery_code';
    };

const FORM_ID = 'step-up-form';

interface Props {
  // Finishes "... needs a sign in from the last 15 minutes."
  readonly what: string;
  // The step asks every time, so the age of the last sign in is beside the point.
  readonly always?: boolean;
  readonly onClose: (confirmed: boolean) => void;
}

// The common case first: the current password in the dialog, the other ways as plain links
// under it, and the code replaces the password field in place.
export function StepUpDialog({ what, always = false, onClose }: Props): ReactNode {
  const pathname = usePathname();
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [error, setError] = useState<string | undefined>();
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  async function requestCode(choices: StepUpChoices) {
    setError(undefined);
    setWrong(false);
    setStep({ kind: 'code', choices, challenge: null });
    const sent = settle(await stepUpSendCode());
    if (sent.ok) setStep({ kind: 'code', choices, challenge: sent.value });
    else setError(problemWords(sent.problem));
  }

  useEffect(() => {
    live.current = true;
    void (async () => {
      const read = settle<StepUpChoices>(await stepUpChoices());
      if (!live.current) return;
      if (!read.ok) {
        setStep({ kind: 'failed', words: problemWords(read.problem) });
        return;
      }
      const ways = stepUpWays(read.value);
      if (ways.includes('factor')) setStep({ kind: 'factor', choices: read.value, code: 'totp' });
      else if (ways.includes('password')) setStep({ kind: 'password', choices: read.value });
      else if (ways.includes('email')) await requestCode(read.value);
      else setStep({ kind: 'code', choices: read.value, challenge: null });
    })();
    return () => {
      live.current = false;
    };
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind === 'loading' || step.kind === 'failed') return;
    const typed = new FormData(event.currentTarget).get('secret');
    setBusy(true);
    setError(undefined);
    setWrong(false);
    const secret = typeof typed === 'string' ? typed : '';
    let proved;
    if (step.kind === 'factor') {
      proved = settle(await stepUpWithFactor({ kind: step.code, code: secret }));
    } else if (step.kind === 'password') {
      proved = settle(await stepUpWithPassword(secret));
    } else {
      proved = settle(await stepUpWithCode(step.challenge ?? '', secret));
    }
    setBusy(false);
    if (proved.ok) {
      onClose(true);
      return;
    }
    const refusal = proved.problem.kind === 'refused' ? proved.problem.code : null;
    // The factor was turned on since the dialog opened: only it is accepted now.
    if (refusal === 'AUTH_FACTOR_REQUIRED') {
      setStep({ kind: 'factor', choices: step.choices, code: 'totp' });
      return;
    }
    if (step.kind === 'factor') {
      if (refusal === 'AUTH_FACTOR_INVALID') setWrong(true);
      else if (refusal === 'AUTH_FACTOR_DISABLED') {
        setStep({ ...step, code: 'recovery_code' });
        setError(FACTOR_PAUSED);
      } else if (proved.problem.kind === 'limited' && step.code === 'totp') {
        setError(`${problemWords(proved.problem)} A recovery code still works.`);
      } else setError(problemWords(proved.problem));
      return;
    }
    if (
      proved.problem.kind === 'refused' &&
      (proved.problem.code === 'AUTH_CREDENTIALS_INVALID' ||
        proved.problem.code === 'AUTH_CODE_INVALID')
    ) {
      setWrong(true);
      return;
    }
    setError(problemWords(proved.problem));
  }

  const choices =
    step.kind === 'password' || step.kind === 'code' || step.kind === 'factor'
      ? step.choices
      : null;
  const ways: readonly StepUpWay[] = choices === null ? [] : stepUpWays(choices);
  const back = `next=${encodeURIComponent(pathname)}`;
  const description = always
    ? `${what} asks you to confirm it is you each time, however recent your last sign in.`
    : choices === null
      ? `${what} needs a sign in from the last 15 minutes.`
      : `${what} needs a sign in from the last 15 minutes. Your last one was ${ageWords(
          choices.lastSignIn,
        )}.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title="Confirm it is you"
      description={description}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form={FORM_ID}
            busy={busy}
            busyLabel="Confirming"
            disabled={step.kind === 'loading' || step.kind === 'failed'}
          >
            Confirm and continue
          </Button>
        </>
      )}
    >
      {step.kind === 'loading' ? (
        <div aria-hidden="true" className="flex flex-col gap-8 py-8">
          <Skeleton width="1/4" />
          <span className="block h-control-md">
            <Skeleton shape="block" />
          </span>
        </div>
      ) : null}
      {step.kind === 'failed' ? <p>{step.words}</p> : null}
      {choices === null ? null : (
        <form id={FORM_ID} onSubmit={(event) => void submit(event)} className="flex flex-col gap-8">
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={choices.address}
            readOnly
            hidden
          />
          {step.kind === 'factor' ? (
            <TextField
              key={step.code}
              id="step-up-factor"
              name="secret"
              label={
                step.code === 'totp' ? '6 digit code from your app' : 'One of your recovery codes'
              }
              inputMode={step.code === 'totp' ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={step.code === 'totp' ? 7 : 40}
              required
              {...(wrong ? { error: FACTOR_WRONG } : {})}
            />
          ) : step.kind === 'password' ? (
            <TextField
              key="password"
              id="step-up-password"
              name="secret"
              label="Your password"
              type="password"
              autoComplete="current-password"
              required
              {...(wrong
                ? { error: 'That password is not right. You can also use an email code.' }
                : {})}
            />
          ) : (
            <TextField
              key="code"
              id="step-up-code"
              name="secret"
              label={`Code sent to ${choices.address}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={9}
              required
              {...(wrong ? { error: 'That code is not right, or it has expired.' } : {})}
            />
          )}
          <p className="flex flex-wrap gap-x-16 gap-y-4">
            {step.kind === 'factor' ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setWrong(false);
                  setError(undefined);
                  setStep({ ...step, code: step.code === 'totp' ? 'recovery_code' : 'totp' });
                }}
              >
                {step.code === 'totp' ? 'Use a recovery code instead' : 'Use my app instead'}
              </Button>
            ) : null}
            {step.kind === 'password' && ways.includes('email') ? (
              <Button variant="quiet" size="sm" onClick={() => void requestCode(choices)}>
                Email me a code instead
              </Button>
            ) : null}
            {step.kind === 'code' && ways.includes('password') ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setWrong(false);
                  setStep({ kind: 'password', choices });
                }}
              >
                Use my password instead
              </Button>
            ) : null}
            {ways.includes('google') ? (
              <ButtonLink
                variant="quiet"
                size="sm"
                href={`/auth/oauth/google/start?purpose=step_up&${back}`}
              >
                Sign in again with Google
              </ButtonLink>
            ) : null}
            {ways.includes('github') ? (
              <ButtonLink
                variant="quiet"
                size="sm"
                href={`/auth/oauth/github/start?purpose=step_up&${back}`}
              >
                Sign in again with GitHub
              </ButtonLink>
            ) : null}
          </p>
        </form>
      )}
    </Dialog>
  );
}
