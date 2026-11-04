'use client';
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from 'react';
import {
  finishLink,
  inspectLink,
  joinInvitation,
  openInvitation,
  readBlock,
  redeemCliLink,
  resetStep,
  signInPassword,
  startEmail,
  stopInvitations,
  verifyCode,
} from '../server/sign-in-actions.ts';
import { Submit, useFocusOnChange } from './controls.tsx';
import { isRefusal, refusalNotice, type Provider } from './outcomes.ts';
import { Answer, AuthFrame, Head, Notice, PrimaryLink } from './parts.tsx';
import {
  ChoosePassword,
  CodeElsewhere,
  ContinueAs,
  LinkScreen,
  PasswordScreen,
  Reading,
  ResetScreen,
  SecretPaste,
  SignInScreen,
  SignUpScreen,
  TypedCode,
  VERIFY_LABEL,
  type Shared,
} from './screens.tsx';
import type {
  BlockState,
  CliState,
  InviteState,
  LinkState,
  PasswordState,
  ResetState,
  StartState,
  TypedCodeState,
} from './states.ts';

interface Refused {
  readonly ok: false;
  readonly code: string;
}

// The server reference goes straight to useActionState, which is what keeps these forms
// working with scripts off. Stated here because React cannot infer the payload from it.
function useForm<T extends object>(
  action: (state: unknown, form: FormData) => Promise<T | Refused>,
  initial: T,
): [T | Refused, (form: FormData) => void, boolean] {
  const start = initial as Awaited<T | Refused>;
  return useActionState<T | Refused, FormData>(action, start) as [
    T | Refused,
    (form: FormData) => void,
    boolean,
  ];
}

// A refusal comes back in place of the form's state, with scripts on or off. Its code is a
// fixed word, so it can stand as the reference a person passes on.
function noticed<T extends object>(state: T | Refused, empty: T) {
  if (isRefusal(state)) return { view: empty, notice: refusalNotice(state, state.code) };
  return { view: state as T, notice: undefined };
}

type SignInBase = Omit<Parameters<typeof SignInScreen>[0], 'action' | 'email' | 'invalid'>;

export function SignInForm(props: SignInBase): ReactNode {
  const [state, action] = useForm<StartState>(startEmail, {});
  const { view, notice } = noticed(state, {} as StartState);
  const focus = useFocusOnChange(state);
  return (
    <div ref={focus} className="contents">
      <SignInScreen
        {...props}
        action={action}
        email={view.email}
        invalid={view.invalid}
        notice={notice ?? view.notice ?? props.notice}
      />
    </div>
  );
}

type SignUpBase = Omit<Parameters<typeof SignUpScreen>[0], 'action' | 'email' | 'invalid'>;

export function SignUpForm(props: SignUpBase): ReactNode {
  const [state, action] = useForm<StartState>(startEmail, {});
  const { view, notice } = noticed(state, {} as StartState);
  const focus = useFocusOnChange(state);
  return (
    <div ref={focus} className="contents">
      <SignUpScreen
        {...props}
        action={action}
        email={view.email}
        invalid={view.invalid}
        notice={notice ?? view.notice}
      />
    </div>
  );
}

function useFragment(run: (fragment: string) => void): void {
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const fragment = window.location.hash.slice(1);
    // Out of the address bar and the history entry before anything else happens.
    if (fragment !== '') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    document.documentElement.removeAttribute('data-fragment');
    run(fragment);
  }, [run]);
}

function asForm(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

interface VerifyProps extends Shared {
  readonly email: string | null;
  readonly fromSignUp: boolean;
}

export function VerifyForm({ hosted, csrf, email, fromSignUp }: VerifyProps): ReactNode {
  const [typed, typedAction] = useForm<TypedCodeState>(verifyCode, {});
  const [link, readAction, reading] = useForm<LinkState>(inspectLink, { kind: 'idle' });
  const [finished, finishAction] = useForm<LinkState>(finishLink, { kind: 'idle' });
  const [reset, resetAction] = useForm<ResetState>(resetStep, { step: 'ask' });
  useFragment((fragment) => {
    if (fragment === '') return;
    startTransition(() => {
      readAction(asForm({ csrf, fragment }));
    });
  });
  const { view: linked } = noticed(link, { kind: 'idle' } as LinkState);
  const { view: done } = noticed(finished, { kind: 'idle' } as LinkState);
  const current = done.kind === 'idle' ? linked : done;
  const { view: typedView, notice } = noticed(typed, {} as TypedCodeState);
  const focus = useFocusOnChange(current.kind === 'idle' ? typed : current);
  const { view: resetView } = noticed(reset, { step: 'ask' } as ResetState);
  if (resetView.step === 'saved' || (resetView.step === 'choose' && current.kind === 'choose')) {
    return <ResetScreen hosted={hosted} csrf={csrf} action={resetAction} state={resetView} />;
  }
  return (
    <div ref={focus} className="contents">
      <AuthFrame hosted={hosted} label={VERIFY_LABEL} busy={reading}>
        <div className="auth-reading contents">
          <Reading title="Signing you in" />
        </div>
        {current.kind === 'here' ? (
          <ContinueAs
            action={finishAction}
            csrf={csrf}
            email={current.email}
            challenge={current.challenge}
            code={current.code}
          />
        ) : null}
        {current.kind === 'elsewhere' ? <CodeElsewhere code={current.code} /> : null}
        {current.kind === 'choose' ? (
          <ChoosePassword
            action={resetAction}
            csrf={csrf}
            code={current.code}
            challenge={current.challenge}
          />
        ) : null}
        {current.kind === 'gone' ? (
          <TypedCode
            hosted={hosted}
            csrf={csrf}
            email={null}
            fromSignUp={false}
            problem="expired"
          />
        ) : null}
        {current.kind === 'failed' ? <Notice notice={current.notice} /> : null}
        {current.kind === 'idle' && !reading ? (
          <div className="auth-typed contents">
            <TypedCode
              hosted={hosted}
              csrf={csrf}
              action={typedAction}
              email={email}
              fromSignUp={fromSignUp}
              code={typedView.code}
              problem={typedView.problem}
              notice={notice ?? typedView.notice}
            />
          </div>
        ) : null}
      </AuthFrame>
    </div>
  );
}

type PasswordBase = Omit<
  Parameters<typeof PasswordScreen>[0],
  'action' | 'email' | 'wrong' | 'notice'
>;

export function PasswordForm(props: PasswordBase): ReactNode {
  const [state, action] = useForm<PasswordState>(signInPassword, {});
  const { view, notice } = noticed(state, {} as PasswordState);
  const focus = useFocusOnChange(state);
  return (
    <div ref={focus} className="contents">
      <PasswordScreen
        {...props}
        action={action}
        email={view.email}
        wrong={view.wrong}
        notice={notice ?? view.notice}
      />
    </div>
  );
}

export function ResetForm({ hosted, csrf }: Shared): ReactNode {
  const [state, action] = useForm<ResetState>(resetStep, { step: 'ask' });
  const { view, notice } = noticed(state, { step: 'ask' } as ResetState);
  const focus = useFocusOnChange(state);
  const shown: ResetState = notice === undefined ? view : { step: 'ask', notice };
  return (
    <div ref={focus} className="contents">
      <ResetScreen hosted={hosted} csrf={csrf} action={action} state={shown} />
    </div>
  );
}

export function LinkForm({
  hosted,
  csrf,
  email,
  provider,
}: Shared & { email: string | null; provider: string }): ReactNode {
  const [state, action] = useForm<TypedCodeState>(verifyCode, {});
  const { view } = noticed(state, {} as TypedCodeState);
  const focus = useFocusOnChange(state);
  return (
    <div ref={focus} className="contents">
      <LinkScreen
        hosted={hosted}
        csrf={csrf}
        action={action}
        email={email}
        provider={provider}
        code={view.code}
        wrong={view.problem === 'wrong'}
      />
    </div>
  );
}

const CLI_INVALID = (
  <>
    <Head>
      <Answer claim="This sign in link no longer works." rest="Links work once, for 15 minutes." />
    </Head>
    <p className="auth-lede">Ask whoever runs this server for a new one, or sign in another way.</p>
    <PrimaryLink href="/sign-in">Go to sign in</PrimaryLink>
  </>
);

export function CliForm({ hosted, csrf }: Shared): ReactNode {
  const [state, action, pending] = useForm<CliState>(redeemCliLink, { kind: 'idle' });
  const { view, notice } = noticed(state, { kind: 'idle' } as CliState);
  useFragment((fragment) => {
    if (fragment === '') return;
    startTransition(() => {
      action(asForm({ csrf, token: fragment }));
    });
  });
  return (
    <AuthFrame hosted={hosted} label="Sign in" busy={pending}>
      {view.kind === 'invalid' ? CLI_INVALID : null}
      {view.kind === 'failed' ? <Notice notice={view.notice} /> : null}
      {notice === undefined ? null : <Notice notice={notice} />}
      {view.kind === 'idle' && notice === undefined ? (
        <>
          <div className="auth-reading contents">
            <Reading title="Signing you in" />
          </div>
          <div className="auth-typed contents">
            <Head>
              <Answer claim="Sign in with your link." rest="Paste the part after # in the link." />
            </Head>
            <SecretPaste
              action={action}
              csrf={csrf}
              label="The part after #"
              submit="Sign in"
              field="token"
            />
          </div>
        </>
      ) : null}
    </AuthFrame>
  );
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

function InvitationFacts({ state }: { state: Extract<InviteState, { email: string }> }): ReactNode {
  const when = new Date(state.expiresAt).toUTCString().slice(5, 22);
  return (
    <dl className="auth-facts">
      <div>
        <dt>Organization</dt>
        <dd>{state.organizationName}</dd>
      </div>
      <div>
        <dt>Your role</dt>
        <dd>
          {ROLE_WORDS[state.role] ?? state.role}
          {state.projectRole === null ? '' : `, ${state.projectRole} on every project`}
        </dd>
      </div>
      <div>
        <dt>Invited by</dt>
        <dd>{state.inviterName}</dd>
      </div>
      <div>
        <dt>For</dt>
        <dd>{state.email}</dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd className="tabular-nums">
          <time dateTime={state.expiresAt}>{when} UTC</time>
        </dd>
      </div>
    </dl>
  );
}

const INVALID_INVITE = (
  <>
    <Head>
      <Answer
        claim="This invitation no longer works."
        rest="It may have expired, been used, or been withdrawn."
      />
    </Head>
    <p className="auth-lede">
      Invitations last 7 days and work once. Ask the person who invited you to send a new one.
    </p>
    <p className="auth-links">
      <a href="/sign-in">Sign in</a>
    </p>
  </>
);

export function InviteForm({ hosted, csrf }: Shared): ReactNode {
  const [state, action] = useForm<InviteState>(openInvitation, { kind: 'reading' });
  const [joined, joinAction] = useForm<InviteState>(joinInvitation, { kind: 'reading' });
  useFragment((fragment) => {
    startTransition(() => {
      action(asForm({ csrf, token: fragment }));
    });
  });
  const idle = !isRefusal(joined) && joined.kind === 'reading';
  const { view, notice } = noticed<InviteState>(idle ? state : joined, { kind: 'invalid' });
  return (
    <AuthFrame hosted={hosted} label="Invitation" busy={view.kind === 'reading'}>
      {view.kind === 'reading' ? (
        <>
          <div className="auth-needs-script contents">
            <Reading title="Opening your invitation" rows={2} />
          </div>
          <noscript>
            <p className="auth-lede">
              Scripts are off, so this page cannot read the link. Paste the part after # below.
            </p>
            <SecretPaste
              action={action}
              csrf={csrf}
              label="The part after #"
              submit="Open invitation"
              field="token"
            />
          </noscript>
        </>
      ) : null}
      {view.kind === 'invalid' ? INVALID_INVITE : null}
      {view.kind === 'failed' ? <Notice notice={view.notice} /> : null}
      {notice === undefined ? null : <Notice notice={notice} />}
      {view.kind === 'signed_out' ? (
        <>
          <Head>
            <Answer
              claim={`${view.inviterName} invited you to ${view.organizationName}.`}
              rest="Join to work on its docs, content and status pages."
            />
          </Head>
          <InvitationFacts state={view} />
          <div className="auth-form">
            <PrimaryLink href="/sign-in?next=%2Finvite">{`Sign in as ${view.email} to join`}</PrimaryLink>
            <p className="auth-fine">
              Joining uses one of {view.organizationName}&apos;s seats, paid by{' '}
              {view.organizationName}. It costs you nothing.
            </p>
            <p className="auth-links">
              <a href={view.blockHref}>I did not expect this invitation</a>
            </p>
          </div>
        </>
      ) : null}
      {view.kind === 'match' ? (
        <>
          <Head>
            <Answer
              claim={`${view.inviterName} invited you to ${view.organizationName}.`}
              rest="Join to work on its docs, content and status pages."
            />
          </Head>
          <InvitationFacts state={view} />
          <form className="auth-form" action={joinAction}>
            <input type="hidden" name="token" value={view.token} />
            <Submit label={`Join ${view.organizationName}`} busyLabel="Joining" />
            <p className="auth-fine">
              Signed in as {view.email}. <a href="/">Not now</a>
            </p>
          </form>
        </>
      ) : null}
      {view.kind === 'mismatch' ? (
        <>
          <Head>
            <Answer
              claim="This invitation is for another address."
              rest={`You are signed in as ${view.signedInAs}.`}
            />
          </Head>
          <p className="auth-lede">
            {view.inviterName} invited <span className="auth-address">{view.email}</span> to{' '}
            {view.organizationName}. Sign in with that address to join.
          </p>
          <form className="auth-form" method="post" action="/sign-out">
            <Submit label={`Sign out and continue as ${view.email}`} busyLabel="Signing out" />
            <p className="auth-links">
              <a href="/">Stay signed in as {view.signedInAs}</a>
            </p>
          </form>
        </>
      ) : null}
    </AuthFrame>
  );
}

export function BlockForm({ hosted, csrf }: Shared): ReactNode {
  const [state, action] = useForm<BlockState>(readBlock, { kind: 'reading' });
  const [stopped, stopAction] = useForm<BlockState>(stopInvitations, { kind: 'reading' });
  useFragment((fragment) => {
    if (fragment === '') return;
    startTransition(() => {
      action(asForm({ csrf, token: fragment }));
    });
  });
  const idle = !isRefusal(stopped) && stopped.kind === 'reading';
  const { view, notice } = noticed<BlockState>(idle ? state : stopped, { kind: 'invalid' });
  return (
    <AuthFrame hosted={hosted} label="Invitations" busy={view.kind === 'reading'}>
      {view.kind === 'reading' ? (
        <>
          <div className="auth-needs-script contents">
            <Reading title="Opening this link" />
          </div>
          <noscript>
            <p className="auth-lede">
              Scripts are off, so this page cannot read the link. Paste the part after # below and
              press the button to stop invitations.
            </p>
            <SecretPaste
              action={stopAction}
              csrf={csrf}
              label="The part after #"
              submit="Stop invitations"
              field="token"
            />
          </noscript>
        </>
      ) : null}
      {view.kind === 'failed' ? <Notice notice={view.notice} /> : null}
      {notice === undefined ? null : <Notice notice={notice} />}
      {view.kind === 'ask' ? (
        <>
          <Head>
            <Answer
              claim={`Stop invitations from ${view.organizationName}?`}
              rest="This address will not get invitations from this organization again."
            />
          </Head>
          <form className="auth-form" action={stopAction}>
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="token" value={view.token} />
            <p className="auth-lede">
              Nothing else changes. You keep any account you have, and other organizations can still
              invite you.
            </p>
            <Submit label={`Stop invitations from ${view.organizationName}`} busyLabel="Stopping" />
            <p className="auth-fine">
              Opening this page changed nothing. Only the button does, so a mail scanner that
              follows links cannot do it for you.
            </p>
          </form>
        </>
      ) : null}
      {view.kind === 'done' ? (
        <>
          <Head>
            <Answer
              claim="Done."
              rest={`${view.organizationName} can no longer invite this address.`}
            />
          </Head>
          <p className="auth-lede">
            If anyone at {view.organizationName} tries to invite this address again, they will see
            that it asked not to receive their invitations. No email reaches you.
          </p>
        </>
      ) : null}
      {view.kind === 'invalid' ? (
        <>
          <Head>
            <Answer
              claim="This link no longer works."
              rest="Links to stop invitations last 30 days and work once."
            />
          </Head>
          <p className="auth-lede">
            Your earlier choice still stands if you made one. To stop invitations from an
            organization, use the link in its newest invitation.
          </p>
        </>
      ) : null}
    </AuthFrame>
  );
}

export type { Provider };
