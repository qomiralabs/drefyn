import type { ReactNode } from 'react';
import { FACTOR_PAUSED, FACTOR_WRONG } from '../settings/factor-words.ts';
import { Submit } from './controls.tsx';
import type { FormNotice } from './outcomes.ts';
import { Answer, AuthFrame, CodeField, Head, Notice, PrimaryLink } from './parts.tsx';
import type { FormAction, Shared } from './screens.tsx';

export type FactorKind = 'totp' | 'recovery_code';

export const FACTOR_PAGE = '/sign-in/factor';
// A link, so switching works with scripts off and never carries what was typed.
const RECOVERY_QUERY = 'use=recovery';

export interface FactorProps extends Shared {
  readonly action?: FormAction;
  readonly kind: FactorKind;
  readonly problem?: 'wrong' | 'disabled' | 'expired' | undefined;
  readonly notice?: FormNotice | undefined;
}

// A replaced or timed out challenge has one way forward. There is one challenge per person,
// so another browser would not help, and the page never suggests one.
function Gone(): ReactNode {
  return (
    <>
      <Head>
        <Answer
          claim="This sign in timed out."
          rest="Start signing in again. Nobody was signed in."
        />
      </Head>
      <p className="auth-lede">
        The second step waits 10 minutes and allows 5 tries. Signing in again starts a new one.
      </p>
      <PrimaryLink href="/sign-in">Start signing in again</PrimaryLink>
    </>
  );
}

export function FactorScreen(props: FactorProps): ReactNode {
  const { site, csrf, problem, notice } = props;
  // Paused authenticator codes leave the recovery code as the way in.
  const kind: FactorKind = problem === 'disabled' ? 'recovery_code' : props.kind;
  const totp = kind === 'totp';
  if (problem === 'expired') {
    return (
      <AuthFrame site={site} label="Sign in">
        <Gone />
      </AuthFrame>
    );
  }
  const error =
    problem === 'wrong' ? FACTOR_WRONG : problem === 'disabled' ? FACTOR_PAUSED : undefined;
  return (
    <AuthFrame site={site} label="Sign in">
      <Head>
        {totp ? (
          <Answer claim="One more step." rest="Enter the code from your authenticator app." />
        ) : (
          <Answer claim="One more step." rest="Enter one of your recovery codes." />
        )}
      </Head>
      {notice === undefined ? null : (
        <Notice notice={notice} others={totp ? ' A recovery code still works.' : ''} />
      )}
      <form className="auth-form" action={props.action}>
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="kind" value={kind} />
        {totp ? (
          <CodeField
            id="code"
            digits={6}
            label="6 digit code"
            hint="From the app on your phone. It changes every 30 seconds."
            error={error}
          />
        ) : (
          <CodeField
            id="code"
            letters
            label="Recovery code"
            hint="Each one works once. Spaces and hyphens do not matter."
            error={error}
          />
        )}
        <Submit label="Sign in" busyLabel="Signing in" />
      </form>
      <div className="auth-ways">
        <p className="auth-links">
          {totp ? (
            <a href={`${FACTOR_PAGE}?${RECOVERY_QUERY}`}>Use a recovery code instead</a>
          ) : (
            <a href={FACTOR_PAGE}>Use my authenticator app instead</a>
          )}
        </p>
        <p className="auth-fine">
          {site.hosted
            ? 'Lost your phone and your recovery codes? Drefyn support can turn the second step off after checking it is you, which takes a few days.'
            : 'Lost your phone and your recovery codes? Whoever runs this Drefyn server can turn the second step off for you.'}
        </p>
        <p className="auth-links">
          <a href="/sign-in">Sign in as someone else</a>
        </p>
      </div>
    </AuthFrame>
  );
}
