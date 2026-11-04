import { TextField } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { SecretField, Submit } from './controls.tsx';
import { Answer, AuthFrame, FieldError, Head, Notice } from './parts.tsx';
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
  readonly hosted: boolean;
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
  hosted,
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
    <AuthFrame hosted={hosted} label="Welcome">
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
            label="Password (optional)"
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
  readonly hosted: boolean;
  readonly email: string;
  // The host part of this server's own address, the start of every organization's URL.
  readonly host: string;
  // Already in an organization, so this is a second one and there is a way back.
  readonly member: boolean;
  readonly invitation: Invitation | null;
  readonly action?: FormAction;
  readonly state?: OrganizationState;
}

const NAME_HINT = 'Your company or team. Web addresses are not allowed in names.';
const SLUG_HINT =
  'Lowercase letters, numbers and hyphens. Anyone can see whether an address is taken, and nothing else.';
const SLUG_MAX = 40;
const SUGGESTIONS = ['labs', 'hq'] as const;

function slugProblem({ problem, slug }: OrganizationState, host: string): string | undefined {
  if (problem === 'address') {
    return 'Use lowercase letters, numbers and hyphens, starting and ending with a letter or number. Some words are kept for Drefyn itself.';
  }
  if (problem !== 'taken' || slug === undefined) return undefined;
  const tries = SUGGESTIONS.map((word) => `${slug}-${word}`);
  const fits = tries.every((word) => word.length <= SLUG_MAX);
  return fits
    ? `${host}/${slug} is taken. Try ${tries.join(' or ')}.`
    : `${host}/${slug} is taken. Try another.`;
}

function AddressField({ host, state }: { host: string; state: OrganizationState }): ReactNode {
  const error = slugProblem(state, host);
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor="organization-slug" className="text-body-s font-medium text-body">
        Address
      </label>
      <span id="organization-slug-hint" className="max-w-measure text-caption text-secondary">
        {SLUG_HINT}
      </span>
      <div className="auth-affix" data-invalid={error === undefined ? undefined : ''}>
        <span aria-hidden="true">{host}/</span>
        <input
          id="organization-slug"
          name="slug"
          defaultValue={state.slug}
          maxLength={SLUG_MAX}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          required
          autoFocus={error !== undefined}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={
            error === undefined
              ? 'organization-slug-hint'
              : 'organization-slug-hint organization-slug-error'
          }
        />
      </div>
      {error === undefined ? null : <FieldError id="organization-slug-error">{error}</FieldError>}
    </div>
  );
}

export function OrganizationScreen({
  hosted,
  email,
  host,
  member,
  invitation,
  action,
  state = {},
}: OrganizationProps): ReactNode {
  const limited = state.limited === true;
  return (
    <AuthFrame hosted={hosted} label="New organization">
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
          autoFocus={state.problem === undefined || state.problem === 'name'}
          {...(state.problem === 'name' ? { error: NAME_HINT } : {})}
        />
        <AddressField host={host} state={state} />
        <Submit
          label="Create organization"
          busyLabel="Creating"
          stopped={limited ? 'Paused until tomorrow.' : undefined}
        />
        {hosted ? (
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
  hosted,
  email,
  invitation,
}: {
  hosted: boolean;
  email: string;
  invitation: Invitation | null;
}): ReactNode {
  return (
    <AuthFrame hosted={hosted} label="Organizations">
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
