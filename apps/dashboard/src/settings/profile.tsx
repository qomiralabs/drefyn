'use client';
import { Button, Dialog, IconMail, TextField, toast } from '@drefyn/ui/react';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { beginEmailChange, finishEmailChange, saveName } from '../server/settings-actions.ts';
import { dayWords } from './models.ts';
import { Fine, PageHead, PageNotice, Row, Rows, SectionHead, SettingsPage } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords } from './results.ts';

export interface ProfileFacts {
  readonly name: string;
  readonly email: string;
  readonly confirmedAt: string | null;
  readonly organizations: readonly string[];
}

type Dialogs = 'none' | 'address' | 'code';

function seenBy(organizations: readonly string[]): string {
  if (organizations.length === 0) return 'Your name is what people in your organizations see.';
  const last = organizations.at(-1);
  const named =
    organizations.length === 1
      ? last
      : `${organizations.slice(0, -1).join(', ')} and ${last ?? ''}`;
  return `Your name is what people in ${named ?? ''} see.`;
}

function ChangeEmail({
  facts,
  initial,
  initialAddress = '',
  onClose,
  onChanged,
}: {
  facts: ProfileFacts;
  initial: Exclude<Dialogs, 'none'>;
  initialAddress?: string;
  onClose: () => void;
  onChanged: (address: string) => void;
}): ReactNode {
  const { act } = useSettings();
  const [step, setStep] = useState(initial);
  const [address, setAddress] = useState(initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [wrong, setWrong] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setWrong(false);
    const field = new FormData(event.currentTarget).get('value');
    const typed = typeof field === 'string' ? field : '';
    if (step === 'address') {
      const started = await act('Changing your address', () => beginEmailChange(typed));
      setBusy(false);
      if (started.ok) {
        setAddress(typed);
        setStep('code');
      } else if (
        started.problem.kind === 'refused' &&
        started.problem.code === 'AUTH_INPUT_INVALID'
      ) {
        setError('Enter a full address, like you@example.com.');
      } else if (!wasCancelled(started)) {
        setError(problemWords(started.problem));
      }
      return;
    }
    const finished = await act('Changing your address', () => finishEmailChange(typed));
    setBusy(false);
    if (finished.ok) {
      onChanged(address);
      return;
    }
    if (finished.problem.kind === 'refused') setWrong(true);
    else if (!wasCancelled(finished)) setError(problemWords(finished.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={step === 'address' ? 'Change your email address' : 'Enter the code'}
      description={
        step === 'address'
          ? 'We send a code to the new address. Nothing changes until you enter it.'
          : `If ${address} can be used, a code is on its way to it.`
      }
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="change-email"
            busy={busy}
            busyLabel={step === 'address' ? 'Sending' : 'Changing'}
          >
            {step === 'address' ? 'Send code' : 'Change address'}
          </Button>
        </>
      )}
    >
      <form
        id="change-email"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-8"
      >
        {step === 'address' ? (
          <>
            <TextField
              key="address"
              id="change-email-address"
              name="value"
              label="New address"
              type="email"
              autoComplete="email"
              required
              defaultValue={address}
            />
            <Fine>
              After the change we sign out your other sessions and email a notice to {facts.email}.
            </Fine>
          </>
        ) : (
          <>
            <TextField
              key="code"
              id="change-email-code"
              name="value"
              label="8 digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={9}
              required
              {...(wrong ? { error: 'That code is not right, or it has expired.' } : {})}
            />
            <Fine>
              No code after a few minutes? The address may already belong to another account, or be
              mistyped.
            </Fine>
            <div>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setStep('address');
                  setWrong(false);
                }}
              >
                Use a different address
              </Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}

export function ProfileScreen({
  facts,
  open = 'none',
  openAddress,
  changedTo = null,
}: {
  facts: ProfileFacts;
  open?: Dialogs;
  openAddress?: string;
  changedTo?: string | null;
}): ReactNode {
  const { act, refresh } = useSettings();
  const [name, setName] = useState(facts.name);
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialogs>(open);
  const [changed, setChanged] = useState<{ from: string; to: string } | null>(
    changedTo === null ? null : { from: facts.email, to: changedTo },
  );
  const email = changed?.to ?? facts.email;

  async function submitName(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNameError(undefined);
    const saved = await act('Changing your name', () => saveName(name));
    setSaving(false);
    if (saved.ok) {
      toast({ title: 'Name saved.' });
      refresh();
    } else if (saved.problem.kind === 'refused') {
      setNameError('Use up to 100 characters, with no web addresses.');
    } else {
      setNameError(problemWords(saved.problem));
    }
  }

  return (
    <SettingsPage width="calm">
      <PageHead
        size="calm"
        label="Your account"
        claim={`${facts.name}, ${email}.`}
        rest={seenBy(facts.organizations)}
      />
      {changed === null ? null : (
        <PageNotice
          icon={<IconMail />}
          title={`Your address is now ${changed.to}.`}
          focusRef={(node) => {
            node?.focus();
          }}
        >
          We signed out your other sessions and emailed a notice to {changed.from}.
        </PageNotice>
      )}
      <form onSubmit={(event) => void submitName(event)} className="flex flex-col gap-8">
        <SectionHead id="profile-name">Name</SectionHead>
        <div className="flex items-start gap-8">
          <div className="min-w-0 flex-1">
            <TextField
              id="profile-name-field"
              label="Your name"
              autoComplete="name"
              value={name}
              onChange={setName}
              maxLength={100}
              required
              {...(nameError === undefined ? {} : { error: nameError })}
            />
          </div>
          <span className="pt-24">
            <Button type="submit" busy={saving} busyLabel="Saving">
              Save name
            </Button>
          </span>
        </div>
      </form>
      <section aria-labelledby="profile-email" className="flex flex-col gap-8">
        <SectionHead id="profile-email">Email address</SectionHead>
        <Rows>
          <Row
            icon={<IconMail />}
            title={email}
            detail={
              <>
                {facts.confirmedAt === null || changed !== null
                  ? 'Confirmed today. '
                  : `Confirmed ${dayWords(facts.confirmedAt, true)}. `}
                Sign in codes and security notices go here.
              </>
            }
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setDialog('address');
                }}
              >
                Change email
              </Button>
            }
          />
        </Rows>
        <Fine>
          Changing it needs a code sent to the new address. Until you enter it, nothing changes.
        </Fine>
      </section>
      {dialog === 'none' ? null : (
        <ChangeEmail
          facts={facts}
          initial={dialog}
          {...(openAddress === undefined ? {} : { initialAddress: openAddress })}
          onClose={() => {
            setDialog('none');
          }}
          onChanged={(to) => {
            setDialog('none');
            setChanged({ from: email, to });
            refresh();
          }}
        />
      )}
    </SettingsPage>
  );
}
