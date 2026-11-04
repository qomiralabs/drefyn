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
import { useFocusOnChange } from './controls.tsx';
import { isRefusal, refusalNotice } from './outcomes.ts';
import { BlockScreen, CliScreen, InviteScreen } from './outcome-screens.tsx';
import { AuthFrame, Notice } from './parts.tsx';
import {
  ChoosePassword,
  CodeElsewhere,
  ContinueAs,
  LinkScreen,
  PasswordScreen,
  Reading,
  ResetScreen,
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
    <CliScreen
      hosted={hosted}
      csrf={csrf}
      view={view}
      notice={notice}
      action={action}
      pending={pending}
    />
  );
}

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
    <InviteScreen
      hosted={hosted}
      csrf={csrf}
      view={view}
      notice={notice}
      action={action}
      joinAction={joinAction}
    />
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
    <BlockScreen
      hosted={hosted}
      csrf={csrf}
      view={view}
      notice={notice}
      action={view.kind === 'reading' ? action : stopAction}
    />
  );
}
