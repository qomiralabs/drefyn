'use client';
import { Button, Dialog, IconAlert, IconKey, TextField, toast } from '@drefyn/ui/react';
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { removeSecondFactor } from '../server/settings-actions.ts';
import {
  FACTOR_PAUSED,
  FACTOR_WRONG,
  factorDetail,
  factorNoticeWords,
  showFactorRow,
  type FactorFacts,
  type FactorNotice,
} from './factor-words.ts';
import { Fine, PageNotice, Row, Rows, SectionHead } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords } from './results.ts';

type Kind = 'totp' | 'recovery_code';

// The enrolment and replacement posts are plain forms to these routes, with scripts on or
// off: the page they answer with is the only place a secret or a code is ever shown.
const START = '/account/second-factor/start';
const REPLACE = '/account/second-factor/replace';

function CodeInput({
  id,
  kind,
  wrong,
  onSwitch,
}: {
  id: string;
  kind: Kind;
  wrong: boolean;
  onSwitch: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-8">
      <input type="hidden" name="kind" value={kind} />
      <TextField
        key={kind}
        id={id}
        name="code"
        label={kind === 'totp' ? '6 digit code from your app' : 'One of your recovery codes'}
        inputMode={kind === 'totp' ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={kind === 'totp' ? 7 : 40}
        required
        autoFocus
        {...(wrong ? { error: FACTOR_WRONG } : {})}
      />
      <p>
        <Button variant="quiet" size="sm" onClick={onSwitch}>
          {kind === 'totp' ? 'Use a recovery code instead' : 'Use my app instead'}
        </Button>
      </p>
    </div>
  );
}

// New codes come back as a page from the route, so the form posts for real and the dialog
// only gathers the code. The old codes stop working when the new ones are written.
function ReplaceDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [kind, setKind] = useState<Kind>('totp');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Make new recovery codes"
      description="Your current codes stop working as soon as the new ones appear. Confirm with a code first."
      busy={busy}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="replace-codes"
            busy={busy}
            busyLabel="Making codes"
          >
            Make new codes
          </Button>
        </>
      )}
    >
      <form
        id="replace-codes"
        method="post"
        action={REPLACE}
        onSubmit={() => {
          setBusy(true);
        }}
      >
        <CodeInput
          id="replace-code"
          kind={kind}
          wrong={false}
          onSwitch={() => {
            setKind((now) => (now === 'totp' ? 'recovery_code' : 'totp'));
          }}
        />
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  onClose,
  onRemoved,
}: {
  onClose: () => void;
  onRemoved: () => void;
}): ReactNode {
  const { act } = useSettings();
  const [kind, setKind] = useState<Kind>('totp');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get('code');
    setBusy(true);
    setWrong(false);
    setError(undefined);
    const done = await act('Turning off your authenticator app', () =>
      removeSecondFactor({ kind, code: typeof typed === 'string' ? typed : '' }),
    );
    setBusy(false);
    if (done.ok) {
      onRemoved();
      return;
    }
    const code = done.problem.kind === 'refused' ? done.problem.code : null;
    if (code === 'AUTH_FACTOR_INVALID') setWrong(true);
    else if (code === 'AUTH_FACTOR_DISABLED') {
      setKind('recovery_code');
      setError(FACTOR_PAUSED);
    } else if (done.problem.kind === 'limited' && kind === 'totp') {
      setError(`${problemWords(done.problem)} A recovery code still works.`);
    } else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Turn off your authenticator app"
      description="Signing in will ask only for your first step again. We sign out your other sessions and email you a notice."
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="remove-factor"
            busy={busy}
            busyLabel="Turning off"
          >
            Turn off
          </Button>
        </>
      )}
    >
      <form id="remove-factor" onSubmit={(event) => void submit(event)}>
        <CodeInput
          id="remove-code"
          kind={kind}
          wrong={wrong}
          onSwitch={() => {
            setWrong(false);
            setError(undefined);
            setKind((now) => (now === 'totp' ? 'recovery_code' : 'totp'));
          }}
        />
      </form>
    </Dialog>
  );
}

export type FactorDialog = 'none' | 'replace' | 'remove';

export function SecondFactorSection({
  facts,
  notice,
  open = 'none',
}: {
  facts: FactorFacts | null;
  notice: FactorNotice | null;
  open?: FactorDialog;
}): ReactNode {
  const { confirm, refresh } = useSettings();
  const [dialog, setDialog] = useState<FactorDialog>(open);
  const [shown, setShown] = useState<FactorNotice | null>(notice);
  const [gone, setGone] = useState(false);
  const start = useRef<HTMLFormElement>(null);
  if (facts === null) return null;
  const current: FactorFacts =
    gone && facts !== 'failed' ? { ...facts, enrolled: false, recoveryCodesLeft: 0 } : facts;
  if (!showFactorRow(current)) return null;
  const enrolled = current !== 'failed' && current.enrolled;
  const available = current !== 'failed' && current.available;

  // Enrolment accepts no sign in as proof, however recent, so the prompt always comes
  // first. Without scripts the form posts straight away and the route sends the person
  // back to confirm.
  async function turnOn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setShown(null);
    if (await confirm('Turning on an authenticator app')) start.current?.submit();
  }

  const [title, detail] = shown === null ? ['', ''] : factorNoticeWords(shown);
  return (
    <section aria-labelledby="factor-head" className="flex flex-col gap-8">
      <SectionHead id="factor-head">Two step sign in</SectionHead>
      {shown === null ? null : (
        <PageNotice
          icon={<IconAlert />}
          title={title}
          focusRef={(node) => {
            node?.focus();
          }}
        >
          {detail}
        </PageNotice>
      )}
      <Rows label="factor-head">
        <Row
          icon={<IconKey />}
          title="Authenticator app"
          detail={factorDetail(current)}
          actions={
            current === 'failed' ? undefined : enrolled ? (
              <>
                {available ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setDialog('replace');
                    }}
                  >
                    New recovery codes
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => {
                    setDialog('remove');
                  }}
                >
                  Turn off
                </Button>
              </>
            ) : (
              <form ref={start} method="post" action={START} onSubmit={(e) => void turnOn(e)}>
                <Button size="sm" type="submit">
                  Turn on
                </Button>
              </form>
            )
          }
        />
      </Rows>
      <Fine>
        Recovery codes each sign you in once if you lose your phone. Turning this on or off signs
        out your other sessions.
      </Fine>
      {dialog === 'replace' ? (
        <ReplaceDialog
          onClose={() => {
            setDialog('none');
          }}
        />
      ) : null}
      {dialog === 'remove' ? (
        <RemoveDialog
          onClose={() => {
            setDialog('none');
          }}
          onRemoved={() => {
            setDialog('none');
            setGone(true);
            toast({
              title: 'Authenticator app turned off.',
              description: 'We signed out your other sessions and emailed you a notice.',
            });
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}
