import { TextField } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { SecretField, Submit } from './controls.tsx';
import { Answer, AuthFrame, Head, Notice } from './parts.tsx';
import type { Site } from './site.ts';
import { passwordProblem, type FormAction } from './screens.tsx';
import type { OrganizationState, WelcomeState } from './states.ts';

export interface Invitation {
  readonly organizationName: string;
  readonly inviterName: string;
}

// A plain post to the route, so it signs out with scripts off too. Outside every other form,
// which is why each screen draws it after its own.
function SignOut({ email }: { email: string }): ReactNode {
  return (
    <form className="auth-signed-in" method="post" action="/sign-out">
      <span>Signed in as</span> <span className="auth-address">{email}</span>
      <button type="submit" className="auth-text-button">
        Sign out
      </button>
    </form>
  );
}

const invitedLine = ({ organizationName, inviterName }: Invitation): string =>
  `You have an invitation to ${organizationName} from ${inviterName}.`;

function OpenInvitation({ invitation }: { invitation: Invitation }): ReactNode {
  return (
    <p className="auth-fine">
      {invitedLine(invitation)} <a href="/invite">Open it</a>.
    </p>
  );
}

export interface WelcomeProps {
  readonly site: Site;
  readonly email: string;
  // Where the person was heading. Empty when nothing is waiting.
  readonly next: string;
  readonly passwordOn: boolean;
  readonly invitation: Invitation | null;
  readonly action?: FormAction;
  readonly state?: WelcomeState;
}

const NAME_REFUSED =
  'Use your name as you would write it. Web addresses are not allowed, and it needs at least one character.';
const LATE =
  'It has been a while since you signed in, so a password cannot be saved here. Leave this empty and add one later.';

export function WelcomeScreen({
  site,
  email,
  next,
  passwordOn,
  invitation,
  action,
  state = {},
}: WelcomeProps): ReactNode {
  const password =
    state.problem === 'late'
      ? LATE
      : passwordProblem(
          state.problem === 'password' ? state.rules : undefined,
          state.problem === 'breached',
        );
  return (
    <AuthFrame site={site} label="Welcome">
      <Head>
        <Answer claim="Welcome to Drefyn." rest={`Your address ${email} is confirmed.`} />
      </Head>
      {state.notice === undefined ? null : <Notice notice={state.notice} />}
      <form className="auth-form" action={action}>
        <input type="hidden" name="next" value={next} />
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <TextField
          id="welcome-name"
          label="Your name"
          name="name"
          size="lg"
          autoComplete="name"
          description="Shown to people in your organizations."
          defaultValue={state.name}
          required
          autoFocus
          {...(state.problem === 'name' ? { error: NAME_REFUSED } : {})}
        />
        {passwordOn ? (
          <SecretField
            id="welcome-password"
            label="Password"
            name="password"
            autoComplete="new-password"
            optional
            error={password}
            description="At least 15 characters. You can always sign in with an email code instead, or add a password later."
          />
        ) : null}
        <Submit label="Continue" busyLabel="Saving" />
        {invitation === null ? null : (
          <p className="auth-fine">{invitedLine(invitation)} You can join it next.</p>
        )}
      </form>
      <SignOut email={email} />
    </AuthFrame>
  );
}

export interface OrganizationProps {
  readonly site: Site;
  readonly email: string;
  // Already in an organization, so this is a second one and there is a way back.
  readonly member: boolean;
  readonly invitation: Invitation | null;
  readonly action?: FormAction;
  readonly state?: OrganizationState;
}

const NAME_HINT = 'Your company or team. Web addresses are not allowed in names.';

export function OrganizationScreen({
  site,
  email,
  member,
  invitation,
  action,
  state = {},
}: OrganizationProps): ReactNode {
  const limited = state.limited === true;
  return (
    <AuthFrame site={site} label="New organization">
      <Head>
        <Answer
          claim="Name your organization."
          rest="It holds your projects, your people and one plan for all three products."
        />
      </Head>
      {limited ? <Notice notice={{ kind: 'day_limit' }} /> : null}
      {state.notice === undefined ? null : <Notice notice={state.notice} />}
      <form className="auth-form" action={action}>
        <TextField
          id="organization-name"
          label="Name"
          name="name"
          size="lg"
          autoComplete="organization"
          description={NAME_HINT}
          defaultValue={state.name}
          required
          autoFocus
          {...(state.problem === 'name' ? { error: NAME_HINT } : {})}
        />
        <Submit
          label="Create organization"
          busyLabel="Creating"
          stopped={limited ? 'Paused until tomorrow.' : undefined}
        />
        {site.hosted ? (
          <p className="auth-fine">
            New organizations start on the Free plan. There is nothing to pay until you choose
            another.
          </p>
        ) : null}
        {invitation === null ? null : <OpenInvitation invitation={invitation} />}
      </form>
      {member ? (
        <p className="auth-links">
          <a href="/">Back to your organization</a>
        </p>
      ) : null}
      <SignOut email={email} />
    </AuthFrame>
  );
}

export function NoOrganizationScreen({
  site,
  email,
  invitation,
}: {
  site: Site;
  email: string;
  invitation: Invitation | null;
}): ReactNode {
  return (
    <AuthFrame site={site} label="Organizations">
      <Head>
        <Answer
          claim="You are not in an organization yet."
          rest="Organizations on this server start with an invitation."
        />
      </Head>
      {invitation === null ? (
        <p className="auth-lede">
          Ask someone who runs one to invite you, then open the link in that email.
        </p>
      ) : (
        <OpenInvitation invitation={invitation} />
      )}
      <SignOut email={email} />
    </AuthFrame>
  );
}
