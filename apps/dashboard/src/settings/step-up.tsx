'use client';
import { Button, ButtonLink, Dialog, Skeleton, TextField } from '@drefyn/ui/react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';
import {
  stepUpChoices,
  stepUpSendCode,
  stepUpWithCode,
  stepUpWithPassword,
} from '../server/settings-actions.ts';
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
  | { readonly kind: 'code'; readonly choices: StepUpChoices; readonly challenge: string | null };

const FORM_ID = 'step-up-form';

interface Props {
  // Finishes "... needs a sign in from the last 15 minutes."
  readonly what: string;
  readonly onClose: (confirmed: boolean) => void;
}

// The common case first: the current password in the dialog, the other ways as plain links
// under it, and the code replaces the password field in place.
export function StepUpDialog({ what, onClose }: Props): ReactNode {
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
      if (ways.includes('password')) setStep({ kind: 'password', choices: read.value });
      else if (ways.includes('email')) await requestCode(read.value);
      else setStep({ kind: 'code', choices: read.value, challenge: null });
    })();
    return () => {
      live.current = false;
    };
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'password' && step.kind !== 'code') return;
    const typed = new FormData(event.currentTarget).get('secret');
    setBusy(true);
    setError(undefined);
    setWrong(false);
    const secret = typeof typed === 'string' ? typed : '';
    const proved =
      step.kind === 'password'
        ? settle(await stepUpWithPassword(secret))
        : settle(await stepUpWithCode(step.challenge ?? '', secret));
    setBusy(false);
    if (proved.ok) {
      onClose(true);
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

  const choices = step.kind === 'password' || step.kind === 'code' ? step.choices : null;
  const ways: readonly StepUpWay[] = choices === null ? [] : stepUpWays(choices);
  const back = `next=${encodeURIComponent(pathname)}`;
  const description =
    choices === null
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
          {step.kind === 'password' ? (
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
