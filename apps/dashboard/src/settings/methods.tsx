'use client';
import {
  Button,
  Dialog,
  IconLink,
  IconLock,
  IconMail,
  IconPlus,
  IconSignOut,
  Menu,
  MenuItem,
  TextField,
  toast,
} from '@drefyn/ui/react';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import {
  confirmRecent,
  removePassword,
  savePassword,
  unlinkProvider,
} from '../server/settings-actions.ts';
import { dayWords, methodsFrom, plural, type MethodFacts } from './models.ts';
import { Fine, PageHead, PageNotice, Row, Rows, SectionHead, SettingsPage } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords } from './results.ts';
import { EverywhereDialog } from './sessions.tsx';

type Provider = 'github' | 'google';
const PROVIDERS: readonly (readonly [Provider, string])[] = [
  ['github', 'GitHub'],
  ['google', 'Google'],
];

export interface MethodsFacts extends MethodFacts {
  readonly email: string;
  readonly emailOn: boolean;
  readonly passwordsOn: boolean;
  readonly configured: readonly Provider[];
  readonly others: readonly { readonly id: string; readonly browser: string }[];
}

type Dialogs = 'none' | 'password' | 'remove';

const MIN_PASSWORD = 15;

function PasswordDialog({
  email,
  first,
  onClose,
  onSaved,
}: {
  email: string;
  first: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { act } = useSettings();
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setWrong(undefined);
    setError(undefined);
    const done = await act(first ? 'Setting a password' : 'Changing your password', () =>
      savePassword({ first, newPassword: value }),
    );
    setBusy(false);
    if (done.ok) {
      onSaved();
      return;
    }
    if (done.problem.kind === 'refused' && done.problem.code === 'AUTH_PASSWORD_WEAK') {
      setWrong('That one is easy to guess. Try a short sentence of your own.');
    } else if (done.problem.kind === 'refused' && done.problem.code === 'AUTH_PASSWORD_BREACHED') {
      setWrong('That password has appeared in a breach. Choose another one.');
    } else if (done.problem.kind === 'refused' && done.problem.code === 'AUTH_INPUT_INVALID') {
      setWrong(`Use at least ${String(MIN_PASSWORD)} characters.`);
    } else if (!wasCancelled(done)) {
      setError(problemWords(done.problem));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={first ? 'Set a password' : 'Change your password'}
      description={`At least ${String(MIN_PASSWORD)} characters. A short sentence works well.`}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="set-password"
            busy={busy}
            busyLabel="Saving"
          >
            Save password
          </Button>
        </>
      )}
    >
      <form
        id="set-password"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-8"
      >
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="flex items-end gap-8">
          <div className="min-w-0 flex-1">
            <TextField
              id="set-password-new"
              label="New password"
              type={shown ? 'text' : 'password'}
              autoComplete="new-password"
              value={value}
              onChange={setValue}
              required
              description={
                <span data-numeric="">
                  {Array.from(value).length} of {MIN_PASSWORD} characters
                </span>
              }
              {...(wrong === undefined ? {} : { error: wrong })}
            />
          </div>
          <Button
            variant="quiet"
            size="sm"
            aria-pressed={shown}
            aria-label="Show new password"
            onClick={() => {
              setShown((now) => !now);
            }}
          >
            {shown ? 'Hide' : 'Show'}
          </Button>
        </div>
        <Fine>Saving signs out your other sessions and emails a notice to {email}.</Fine>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  facts,
  onClose,
  onRemoved,
}: {
  facts: MethodsFacts;
  onClose: () => void;
  onRemoved: () => void;
}): ReactNode {
  const { act } = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const left = [
    ...(facts.emailOn ? ['email codes'] : []),
    ...facts.identities.map((i) => (i.provider === 'github' ? 'GitHub' : 'Google')),
  ].join(' or ');

  async function confirm() {
    setBusy(true);
    setError(undefined);
    const done = await act('Removing your password', () => removePassword());
    setBusy(false);
    if (done.ok) onRemoved();
    else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Remove your password?"
      description={`You will sign in with ${left}. You can set a new password at any time.`}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button data-autofocus="" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} busyLabel="Removing" onClick={() => void confirm()}>
            Remove password
          </Button>
        </>
      )}
    >
      <p>
        This cannot be undone: the password is deleted, not hidden. We email a notice to{' '}
        {facts.email}.
      </p>
    </Dialog>
  );
}

// After a credential goes, its old holder may still be signed in, so the next step is
// offered right here, and the page does not move on without it being seen.
function Removed({
  what,
  onEverywhere,
  onDismiss,
}: {
  what: string;
  onEverywhere: () => void;
  onDismiss: () => void;
}): ReactNode {
  return (
    <PageNotice
      icon={<IconSignOut />}
      title={`${what} removed.`}
      focusRef={(node) => {
        node?.focus();
      }}
      actions={
        <>
          <Button size="sm" onClick={onEverywhere}>
            Sign out everywhere else
          </Button>
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            Not now
          </Button>
        </>
      }
    >
      If you removed it because someone else might have access, sign out of your other sessions too.
    </PageNotice>
  );
}

export function MethodsScreen({
  facts,
  open = 'none',
  removed: removedAt = null,
  providerFailed = false,
  addOpen = false,
}: {
  facts: MethodsFacts;
  open?: Dialogs;
  removed?: string | null;
  providerFailed?: boolean;
  addOpen?: boolean;
}): ReactNode {
  const { act, complain, refresh } = useSettings();
  const [dialog, setDialog] = useState<Dialogs>(open);
  const [removed, setRemoved] = useState<string | null>(removedAt);
  const [everywhere, setEverywhere] = useState(false);
  const [gone, setGone] = useState<readonly string[]>([]);
  const password = gone.includes('password') ? null : facts.passwordSetAt;
  const identities = facts.identities.filter((i) => !gone.includes(i.provider));
  const { count, only } = methodsFrom({ passwordSetAt: password, identities }, facts.emailOn);
  const linkable = PROVIDERS.filter(
    ([id]) => facts.configured.includes(id) && !identities.some((i) => i.provider === id),
  );

  async function link(provider: Provider) {
    const done = await act(`Linking ${provider === 'github' ? 'GitHub' : 'Google'}`, () =>
      confirmRecent(),
    );
    if (done.ok) {
      window.location.assign(
        `/auth/oauth/${provider}/start?purpose=link&next=${encodeURIComponent('/account/sign-in')}`,
      );
    } else if (!wasCancelled(done)) {
      complain('Could not start linking.', done.problem);
    }
  }

  async function unlink(provider: Provider, label: string) {
    setGone((ids) => [...ids, provider]);
    const done = await act(`Unlinking ${label}`, () => unlinkProvider(provider));
    if (done.ok) {
      setRemoved(label);
      refresh();
      return;
    }
    setGone((ids) => ids.filter((id) => id !== provider));
    if (!wasCancelled(done)) complain(`Could not unlink ${label}.`, done.problem);
  }

  const rest =
    count === 1
      ? 'Add another so you never lose access.'
      : 'Keep at least two, in case one stops working.';

  return (
    <SettingsPage width="calm">
      <PageHead
        size="calm"
        label="Your account"
        claim={`You can sign in ${plural(count, 'way')}.`}
        rest={rest}
      />
      {providerFailed ? (
        <PageNotice icon={<IconLink />} title="That account was not linked.">
          The provider did not finish, or that account belongs to someone else here. Nothing
          changed.
        </PageNotice>
      ) : null}
      {removed === null ? null : (
        <Removed
          what={removed}
          onEverywhere={() => {
            setEverywhere(true);
          }}
          onDismiss={() => {
            setRemoved(null);
          }}
        />
      )}
      <section aria-labelledby="methods-list" className="flex flex-col gap-8">
        <SectionHead
          id="methods-list"
          actions={
            <Menu
              size="sm"
              label="Add a method"
              defaultOpen={addOpen}
              trigger={
                <span className="inline-flex items-center gap-4">
                  <IconPlus />
                  Add a method
                </span>
              }
            >
              {linkable.map(([id, label]) => (
                <MenuItem key={id} id={`link-${id}`} onAction={() => void link(id)}>
                  {`Link ${label}`}
                </MenuItem>
              ))}
              <MenuItem
                id="set-password"
                disabled={password !== null || !facts.passwordsOn}
                reason={
                  password === null
                    ? 'This server has passwords off.'
                    : 'You have one. Change it from its row.'
                }
                onAction={() => {
                  setDialog('password');
                }}
              >
                Set a password
              </MenuItem>
            </Menu>
          }
        >
          Methods
        </SectionHead>
        <Rows label="methods-list">
          <Row
            icon={<IconMail />}
            title="Email code"
            detail={
              facts.emailOn
                ? `Codes go to ${facts.email}. This server turns them on for everyone.`
                : 'Off on this server, because it cannot send email.'
            }
            actions={
              <span className="text-caption text-secondary">
                {facts.emailOn ? 'Always on' : 'Off'}
              </span>
            }
          />
          <Row
            icon={<IconLock />}
            title="Password"
            detail={password === null ? 'Not set.' : `Set ${dayWords(password, true)}.`}
            actions={
              password === null ? (
                facts.passwordsOn ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setDialog('password');
                    }}
                  >
                    Set a password
                  </Button>
                ) : undefined
              ) : (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDialog('password');
                    }}
                  >
                    Change
                  </Button>
                  <Button
                    size="sm"
                    disabled={only}
                    aria-describedby={only ? 'password-only' : undefined}
                    onClick={() => {
                      setDialog('remove');
                    }}
                  >
                    Remove
                  </Button>
                </>
              )
            }
          />
          {PROVIDERS.filter(
            ([id]) => facts.configured.includes(id) || identities.some((i) => i.provider === id),
          ).map(([id, label]) => {
            const linked = identities.find((identity) => identity.provider === id);
            const why = `unlink-${id}`;
            return (
              <Row
                key={id}
                icon={<IconLink />}
                title={label}
                detail={
                  linked === undefined ? (
                    'Not linked.'
                  ) : (
                    <>
                      Linked as {linked.account} on {dayWords(linked.linkedAt, true)}.
                      {only ? (
                        <>
                          {' '}
                          <span id={why}>This is your only way to sign in. Add another first.</span>
                        </>
                      ) : null}
                    </>
                  )
                }
                actions={
                  linked === undefined ? (
                    <Button size="sm" onClick={() => void link(id)}>
                      {`Link ${label}`}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={only}
                      aria-label={`Unlink ${label}`}
                      aria-describedby={only ? why : undefined}
                      onClick={() => void unlink(id, label)}
                    >
                      Unlink
                    </Button>
                  )
                }
              />
            );
          })}
        </Rows>
        {only && password !== null ? (
          <Fine id="password-only">
            This is your only way to sign in. Add another before you remove it.
          </Fine>
        ) : null}
      </section>
      <Fine>
        Linking, unlinking and changing a password ask you to confirm it is you if your last sign in
        was more than 15 minutes ago. Each one emails a notice to your address.
      </Fine>
      {dialog === 'password' ? (
        <PasswordDialog
          email={facts.email}
          first={password === null}
          onClose={() => {
            setDialog('none');
          }}
          onSaved={() => {
            setDialog('none');
            toast({
              title: 'Password saved.',
              description: `We emailed a notice to ${facts.email}.`,
            });
            refresh();
          }}
        />
      ) : null}
      {dialog === 'remove' ? (
        <RemoveDialog
          facts={{ ...facts, identities }}
          onClose={() => {
            setDialog('none');
          }}
          onRemoved={() => {
            setDialog('none');
            setGone((ids) => [...ids, 'password']);
            setRemoved('Password');
            refresh();
          }}
        />
      ) : null}
      {everywhere ? (
        <EverywhereDialog
          sessions={facts.others}
          onClose={() => {
            setEverywhere(false);
          }}
          onDone={(revoked) => {
            setEverywhere(false);
            setRemoved(null);
            toast({ title: `Signed out ${plural(revoked, 'other session')}.` });
            refresh();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
