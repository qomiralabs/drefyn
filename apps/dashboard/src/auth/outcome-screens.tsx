import type { ReactNode } from 'react';
import { Submit } from './controls.tsx';
import type { FormNotice } from './outcomes.ts';
import { Answer, AuthFrame, Head, Notice, PrimaryLink } from './parts.tsx';
import { Reading, SecretPaste, type Shared } from './screens.tsx';
import type { BlockState, CliState, InviteState } from './states.ts';

type FormAction = ((form: FormData) => void) | undefined;

const CLI_INVALID = (
  <>
    <Head>
      <Answer claim="This sign in link no longer works." rest="Links work once, for 15 minutes." />
    </Head>
    <p className="auth-lede">Ask whoever runs this server for a new one, or sign in another way.</p>
    <PrimaryLink href="/sign-in">Go to sign in</PrimaryLink>
  </>
);

export function CliScreen({
  hosted,
  csrf,
  view,
  notice,
  action,
  pending,
}: Shared & {
  view: CliState;
  notice?: FormNotice | undefined;
  action?: FormAction;
  pending?: boolean | undefined;
}): ReactNode {
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

export function InviteScreen({
  hosted,
  csrf,
  view,
  notice,
  action,
  joinAction,
}: Shared & {
  view: InviteState;
  notice?: FormNotice | undefined;
  action?: FormAction;
  joinAction?: FormAction;
}): ReactNode {
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

export function BlockScreen({
  hosted,
  csrf,
  view,
  notice,
  action,
}: Shared & {
  view: BlockState;
  notice?: FormNotice | undefined;
  action?: FormAction;
}): ReactNode {
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
              action={action}
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
          <form className="auth-form" action={action}>
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
