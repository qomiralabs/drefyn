import { IconClock, Skeleton, TextField } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { CopyButton, SecretField, Submit } from './controls.tsx';
import type { FormNotice, Provider } from './outcomes.ts';
import {
  Answer,
  AuthFrame,
  CodeField,
  FieldError,
  Head,
  Notice,
  Or,
  PrimaryLink,
  Providers,
  SpokenCode,
} from './parts.tsx';

export type FormAction = ((form: FormData) => void) | undefined;

export interface Shared {
  readonly hosted: boolean;
  readonly csrf: string;
}

function Hidden({ fields }: { fields: Readonly<Record<string, string>> }): ReactNode {
  return Object.entries(fields).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

const CLI = 'drefyn auth link --email you@example.com --create-organization "Acme"';

function CliCommand({ id }: { id: string }): ReactNode {
  return (
    <div className="auth-cli">
      <code id={id}>{CLI}</code>
      <CopyButton text={CLI} describedBy={id} />
    </div>
  );
}

function othersStill(providers: readonly Provider[], password: boolean): string {
  const names = [
    ...providers.map((p) => (p === 'github' ? 'GitHub' : 'Google')),
    ...(password ? ['passwords'] : []),
  ];
  if (names.length === 0) return '';
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
  return ` ${list ?? ''} still ${names.length === 1 && names[0] !== 'passwords' ? 'works' : 'work'} in the meantime.`;
}

export interface SignInProps extends Shared {
  readonly action?: FormAction;
  readonly email?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly notice?: FormNotice | null | undefined;
  readonly next?: string | undefined;
  readonly providers: readonly Provider[];
  readonly emailOn: boolean;
  readonly passwordOn: boolean;
  readonly signUp: 'open' | 'invite_only' | 'closed';
}

function AddressForm({
  action,
  csrf,
  email,
  invalid,
  next,
  from,
  children,
}: {
  action: FormAction;
  csrf: string;
  email?: string | undefined;
  invalid?: boolean | undefined;
  next?: string | undefined;
  from?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <form className="auth-form" action={action} noValidate>
      <Hidden fields={{ csrf, next: next ?? '', from: from ?? '' }} />
      <TextField
        id="email"
        label="Email address"
        name="email"
        type="email"
        size="lg"
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        required
        defaultValue={email}
        autoFocus
        {...(invalid === true ? { error: 'Enter an address like name@example.com.' } : {})}
      />
      <Submit label="Email me a code" busyLabel="Sending" />
      {children}
    </form>
  );
}

export function SignInScreen(props: SignInProps): ReactNode {
  const { hosted, providers, emailOn, passwordOn, notice, signUp } = props;
  if (!emailOn && providers.length === 0) {
    return (
      <AuthFrame hosted={hosted} label="Set up">
        <Head>
          <Answer
            claim="Sign in is not set up yet."
            rest="This server cannot send email and has no GitHub or Google app."
          />
        </Head>
        <div className="auth-form">
          <p className="auth-lede">
            If you run this server, sign in with a one time link from the command line:
          </p>
          <CliCommand id="cli-command" />
          <p className="auth-fine">
            The link works once, for 15 minutes. To let other people sign in, connect an email
            service or a GitHub or Google app, then restart.
          </p>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame hosted={hosted} label="Sign in">
      <Head>
        <Answer claim="Sign in to Drefyn." rest="One account for Docs, Studio and Status." />
      </Head>
      {providers.length === 0 ? null : (
        <div className="auth-ways">
          <Providers providers={providers} next={props.next} />
          {emailOn ? <Or /> : null}
        </div>
      )}
      {notice === null || notice === undefined ? null : (
        <Notice notice={notice} others={othersStill(providers, passwordOn)} />
      )}
      {emailOn ? (
        <AddressForm
          action={props.action}
          csrf={props.csrf}
          email={props.email}
          invalid={props.invalid}
          next={props.next}
        >
          <p className="auth-fine">
            We send an 8 digit code that works for 10 minutes. There is nothing to remember.
          </p>
          <p className="auth-links">
            {passwordOn ? <a href="/sign-in/password">Use a password instead</a> : null}
            <a href="/sign-in/reset">Forgot your password?</a>
          </p>
        </AddressForm>
      ) : null}
      {signUp === 'open' ? (
        <p className="auth-fine">
          New to Drefyn? <a href="/sign-up">Create an account</a>
        </p>
      ) : null}
      {signUp === 'invite_only' ? (
        <p className="auth-fine">
          No account yet? Ask someone in your organization to invite you. Accounts start with an
          invitation on this server.
        </p>
      ) : null}
    </AuthFrame>
  );
}

export interface SignUpProps extends Shared {
  readonly action?: FormAction;
  readonly state: 'ready' | 'closed' | 'invite_only' | 'paused';
  readonly email?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly notice?: FormNotice | null | undefined;
  readonly providers: readonly Provider[];
}

export function SignUpScreen(props: SignUpProps): ReactNode {
  const { hosted, state, providers } = props;
  const already = (
    <p className="auth-fine">
      Already have an account? <a href="/sign-in">Sign in</a>
    </p>
  );
  if (state === 'closed') {
    return (
      <AuthFrame hosted={hosted} label="Sign up">
        <Head>
          <Answer
            claim="Sign up is not open yet."
            rest="Until it is, accounts start with an invitation from an organization."
          />
        </Head>
        <p className="auth-lede">
          If someone invited you, use the link in their email. Drefyn is open source, so you can
          also run it yourself today.
        </p>
        <hr className="auth-rule" />
        {already}
      </AuthFrame>
    );
  }
  if (state === 'invite_only') {
    return (
      <AuthFrame hosted={hosted} label="Sign up">
        <Head>
          <Answer
            claim="This server does not take sign ups."
            rest="Accounts here start with an invitation from an organization."
          />
        </Head>
        <div className="auth-form">
          <p className="auth-lede">
            Ask an admin of your organization to invite you. If you run this server, create the
            first admin with a one time link:
          </p>
          <CliCommand id="sign-up-cli" />
          <p className="auth-fine">The link works once, for 15 minutes.</p>
        </div>
        <hr className="auth-rule" />
        {already}
      </AuthFrame>
    );
  }
  return (
    <AuthFrame hosted={hosted} label="Sign up">
      <Head>
        <Answer
          claim="Create your Drefyn account."
          rest="Docs, Studio and Status on one account, starting on the free plan."
        />
      </Head>
      {providers.length === 0 ? null : (
        <div className="auth-ways">
          <Providers providers={providers} />
          <Or />
        </div>
      )}
      {props.notice === null || props.notice === undefined ? null : (
        <Notice notice={props.notice} />
      )}
      <AddressForm
        action={props.action}
        csrf={props.csrf}
        email={props.email}
        invalid={props.invalid}
        from="sign-up"
      >
        <p className="auth-fine">
          We ask for your name after the code, and you can add a password then if you want one.
          Nothing to set up now.
        </p>
      </AddressForm>
      <hr className="auth-rule" />
      {hosted ? (
        <p className="auth-fine">
          By creating an account you agree to the <a href="https://drefyn.com/terms">Terms</a> and
          the <a href="https://drefyn.com/privacy">Privacy notice</a>.
        </p>
      ) : null}
      {already}
    </AuthFrame>
  );
}

export interface TypedCodeProps extends Shared {
  readonly action?: FormAction;
  readonly email: string | null;
  readonly fromSignUp: boolean;
  readonly code?: string | undefined;
  readonly problem?: 'wrong' | 'expired' | 'closed' | undefined;
  readonly notice?: FormNotice | undefined;
}

export function TypedCode(props: TypedCodeProps): ReactNode {
  const { problem, email, fromSignUp } = props;
  if (problem === 'expired') {
    return (
      <>
        <Head>
          <Answer claim="This code has stopped working." rest="Send a new one to carry on." />
        </Head>
        <p className="auth-lede">
          Codes last 10 minutes and allow 5 tries. Send a new one, then use the newest email.
        </p>
        <PrimaryLink href="/sign-in">Send a new code</PrimaryLink>
      </>
    );
  }
  if (problem === 'closed') {
    return (
      <Head>
        <Answer
          claim="This server does not take sign ups."
          rest="Accounts here start with an invitation from an organization."
        />
      </Head>
    );
  }
  const who = email ?? 'your address';
  return (
    <>
      <Head>
        <Answer
          claim="Check your email."
          rest={`If ${who} ${fromSignUp ? 'can be used' : 'can sign in'}, a code is on its way.`}
        />
      </Head>
      {props.notice === undefined ? null : <Notice notice={props.notice} />}
      <form className="auth-form" action={props.action}>
        <Hidden fields={{ csrf: props.csrf }} />
        <CodeField
          id="code"
          hint="From the email we just sent. It works for 10 minutes."
          defaultValue={props.code}
          error={
            problem === 'wrong'
              ? 'That code did not work. Check it against the newest email, or send a new code.'
              : undefined
          }
        />
        <Submit label="Sign in" busyLabel="Signing in" />
      </form>
      <div className="auth-ways">
        <p className="auth-fine">No email? Check spam. You can send a new code after a minute.</p>
        {fromSignUp ? (
          <p className="auth-fine">
            Already have a Drefyn account with this address? The code signs you in instead.
          </p>
        ) : null}
        <p className="auth-fine">
          Opened the email on your phone? The link signs in only the browser that asked. Anywhere
          else it shows the code to type here.
        </p>
        <p className="auth-links">
          <a href="/sign-in">Use a different address</a>
        </p>
      </div>
    </>
  );
}

export const VERIFY_LABEL = 'Sign in';

export function ContinueAs({
  action,
  csrf,
  email,
  challenge,
  code,
}: {
  action: FormAction;
  csrf: string;
  email: string;
  challenge: string;
  code: string;
}): ReactNode {
  return (
    <>
      <Head>
        <Answer
          claim={`Continue as ${email}?`}
          rest="You opened the link in the browser that asked for it."
        />
      </Head>
      <form className="auth-form" action={action}>
        <Hidden fields={{ csrf, challenge, code }} />
        <Submit label={`Continue as ${email}`} busyLabel="Signing in" />
        <p className="auth-fine">
          Not you? <a href="/sign-in">Use a different address</a>.
        </p>
      </form>
    </>
  );
}

export function CodeElsewhere({ code }: { code: string }): ReactNode {
  return (
    <>
      <Head>
        <Answer
          claim="Type this code where you asked."
          rest="The link signs in only the browser that asked for it."
        />
      </Head>
      <div className="auth-form">
        <SpokenCode code={code} />
        <p className="auth-lede">
          You asked to sign in on another device or browser. Type this code there. It works for 10
          minutes, and nobody was signed in here.
        </p>
        <p className="auth-links">
          <a href="/sign-in">Sign in on this device instead</a>
        </p>
      </div>
    </>
  );
}

export function Reading({ title, rows = 1 }: { title: string; rows?: number }): ReactNode {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <div className="flex flex-col gap-12" aria-hidden="true">
        <span className="auth-skeleton-title">
          <Skeleton shape="block" />
        </span>
        <span className="auth-skeleton-title">
          <Skeleton shape="block" width="3/4" />
        </span>
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <span className="auth-skeleton-button" key={i}>
          <Skeleton shape="block" />
        </span>
      ))}
    </>
  );
}

export interface PasswordProps extends Shared {
  readonly action?: FormAction;
  readonly email?: string | undefined;
  readonly wrong?: boolean | undefined;
  readonly notice?: FormNotice | undefined;
  readonly next?: string | undefined;
  readonly providers: readonly Provider[];
}

export function PasswordScreen(props: PasswordProps): ReactNode {
  const paused = props.notice?.kind === 'limited' || props.notice?.kind === 'botcheck_down';
  return (
    <AuthFrame hosted={props.hosted} label="Sign in">
      <Head>
        <Answer
          claim="Sign in with a password."
          rest="Or get a code by email, whichever is quicker."
        />
      </Head>
      {props.notice?.kind === 'limited' ? (
        <div className="auth-notice" role="status" tabIndex={-1} data-notice="">
          <IconClock />
          <div>
            <p className="auth-notice-title">Too many password tries for this address.</p>
            <p>
              Try again in <span className="tabular-nums">{props.notice.minutes}</span> minutes, or
              sign in another way now. Codes and linked accounts are not affected.
            </p>
          </div>
        </div>
      ) : props.notice === undefined ? null : (
        <Notice notice={props.notice} />
      )}
      <form className="auth-form" action={props.action} noValidate>
        <Hidden fields={{ csrf: props.csrf, next: props.next ?? '' }} />
        {props.wrong === true ? (
          <p className="auth-field-error" role="alert" tabIndex={-1} data-notice="">
            That address and password do not match.
          </p>
        ) : null}
        <TextField
          id="email"
          label="Email address"
          name="email"
          type="email"
          size="lg"
          autoComplete="username"
          spellCheck={false}
          required
          defaultValue={props.email}
        />
        <SecretField
          id="password"
          label="Password"
          name="password"
          autoComplete="current-password"
        />
        <Submit label="Sign in" busyLabel="Signing in" />
        <p className="auth-links">
          <a href="/sign-in">Email me a code instead</a>
          <a href="/sign-in/reset">Forgot your password?</a>
        </p>
      </form>
      {paused ? <Providers providers={props.providers} next={props.next} /> : null}
    </AuthFrame>
  );
}

const WEAK_WORDS: Readonly<Record<string, string>> = {
  too_short: 'Use at least 15 characters.',
  too_long: 'Use at most 128 characters.',
};
const WEAK_FALLBACK = 'This is one of the first things guessed. Choose another.';

export function passwordProblem(
  rules: readonly string[] | undefined,
  breached: boolean | undefined,
): string | undefined {
  const [rule] = rules ?? [];
  if (breached === true) {
    return 'This password is in known data breaches, so attackers try it early. Choose another.';
  }
  return rule === undefined ? undefined : (WEAK_WORDS[rule] ?? WEAK_FALLBACK);
}

export function ChoosePassword({
  action,
  csrf,
  code,
  challenge,
  rules,
  breached,
  notice,
}: {
  action: FormAction;
  csrf: string;
  code: string;
  challenge: string;
  rules?: readonly string[] | undefined;
  breached?: boolean | undefined;
  notice?: FormNotice | undefined;
}): ReactNode {
  const error = passwordProblem(rules, breached);
  return (
    <>
      <Head>
        <Answer
          claim="Choose a new password."
          rest="At least 15 characters. A short sentence works well."
        />
      </Head>
      {notice === undefined ? null : <Notice notice={notice} />}
      <form className="auth-form" action={action}>
        <Hidden fields={{ csrf, step: 'save', code, challenge }} />
        <SecretField
          id="new-password"
          label="New password"
          name="password"
          autoComplete="new-password"
          error={error}
          description="Spaces and any characters are fine. Paste from a password manager if you use one."
        />
        <Submit label="Save password and sign in" busyLabel="Saving" />
        <p className="auth-fine">Saving signs out every other session and emails a notice.</p>
      </form>
    </>
  );
}

export interface ResetProps extends Shared {
  readonly action?: FormAction;
  readonly state:
    | {
        readonly step: 'ask';
        readonly email?: string;
        readonly invalid?: boolean;
        readonly expired?: boolean;
        readonly notice?: FormNotice;
      }
    | { readonly step: 'code'; readonly email: string; readonly wrong?: boolean }
    | {
        readonly step: 'choose';
        readonly code: string;
        readonly challenge: string;
        readonly rules?: readonly string[];
        readonly breached?: boolean;
        readonly notice?: FormNotice;
      }
    | { readonly step: 'saved'; readonly email: string; readonly returnTo: string };
}

export function ResetScreen({ hosted, csrf, action, state }: ResetProps): ReactNode {
  return (
    <AuthFrame hosted={hosted} label="Reset password">
      {state.step === 'ask' ? (
        <>
          <Head>
            <Answer claim="Reset your password." rest="We send a code to your address first." />
          </Head>
          {state.notice === undefined ? null : <Notice notice={state.notice} />}
          {state.expired === true ? <Notice notice={{ kind: 'expired' }} /> : null}
          <form className="auth-form" action={action} noValidate>
            <Hidden fields={{ csrf, step: 'ask' }} />
            <TextField
              id="email"
              label="Email address"
              name="email"
              type="email"
              size="lg"
              autoComplete="email"
              spellCheck={false}
              required
              defaultValue={state.email}
              autoFocus
              {...(state.invalid === true
                ? { error: 'Enter an address like name@example.com.' }
                : {})}
            />
            <Submit label="Email me a code" busyLabel="Sending" />
            <p className="auth-fine">
              Nothing changes until you save a new password. Saving it signs you out everywhere
              else.
            </p>
            <p className="auth-links">
              <a href="/sign-in">Back to sign in</a>
            </p>
          </form>
        </>
      ) : null}
      {state.step === 'code' ? (
        <>
          <Head>
            <Answer
              claim="Check your email."
              rest={`If ${state.email === '' ? 'your address' : state.email} has a Drefyn account, a code is on its way.`}
            />
          </Head>
          <form className="auth-form" action={action}>
            <Hidden fields={{ csrf, step: 'code', challenge: '' }} />
            <CodeField
              id="code"
              hint="It works for 10 minutes."
              error={
                state.wrong === true
                  ? 'That code did not work. Check it against the newest email, or send a new code.'
                  : undefined
              }
            />
            <Submit label="Continue" busyLabel="Checking" />
            <p className="auth-links">
              <a href="/sign-in/reset">Use a different address</a>
            </p>
          </form>
        </>
      ) : null}
      {state.step === 'choose' ? (
        <ChoosePassword
          action={action}
          csrf={csrf}
          code={state.code}
          challenge={state.challenge}
          rules={state.rules}
          breached={state.breached}
          notice={state.notice}
        />
      ) : null}
      {state.step === 'saved' ? (
        <>
          <Head>
            <Answer
              claim="Password saved."
              rest="You are signed in, and every other session was signed out."
            />
          </Head>
          <div className="auth-form">
            <PrimaryLink href={state.returnTo}>Continue</PrimaryLink>
            <p className="auth-fine">
              We emailed a notice to {state.email}. If this was not you, reset your password again
              and review your sessions.
            </p>
          </div>
        </>
      ) : null}
    </AuthFrame>
  );
}

export interface LinkProps extends Shared {
  readonly action?: FormAction;
  readonly email: string | null;
  readonly provider: string;
  readonly code?: string | undefined;
  readonly wrong?: boolean | undefined;
}

export function LinkScreen(props: LinkProps): ReactNode {
  const { provider, email } = props;
  const who = email ?? 'your address';
  return (
    <AuthFrame hosted={props.hosted} label={`Link ${provider}`}>
      <Head>
        <Answer claim="Confirm it is your account." rest={`${who} already has a Drefyn account.`} />
      </Head>
      <p className="auth-lede">
        To link your {provider} account to it, enter the code we sent to {who}. Nothing is linked
        until you do.
      </p>
      <form className="auth-form" action={props.action}>
        <Hidden fields={{ csrf: props.csrf }} />
        <CodeField
          id="code"
          defaultValue={props.code}
          error={
            props.wrong === true
              ? 'That code did not work. Check it against the newest email, or start again.'
              : undefined
          }
        />
        <Submit label={`Link ${provider} and sign in`} busyLabel="Linking" />
        <p className="auth-links">
          <a href="/sign-in">Cancel and sign in another way</a>
        </p>
      </form>
    </AuthFrame>
  );
}

export function SecretPaste({
  action,
  csrf,
  label,
  submit,
  field,
}: {
  action: FormAction;
  csrf: string;
  label: string;
  submit: string;
  field: string;
}): ReactNode {
  return (
    <form className="auth-form" action={action} noValidate>
      <Hidden fields={{ csrf }} />
      <TextField
        id="pasted"
        label={label}
        name={field}
        size="lg"
        autoComplete="off"
        spellCheck={false}
        required
      />
      <Submit label={submit} busyLabel="Working" />
    </form>
  );
}

export { FieldError };
