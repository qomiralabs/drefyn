'use client';
import { Button, Dialog, IconSignOut, toast } from '@drefyn/ui/react';
import { useState, type ReactNode } from 'react';
import { signOutOthers, signOutSession } from '../server/settings-actions.ts';
import { dayWords, plural, usedWords } from './models.ts';
import { Fine, PageHead, SectionHead, SettingsPage } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords } from './results.ts';

export interface SessionRow {
  readonly id: string;
  readonly browser: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
}

function Table({
  caption,
  rows,
  now,
  action,
}: {
  caption: string;
  rows: readonly SessionRow[];
  now: string;
  action: (row: SessionRow) => ReactNode;
}): ReactNode {
  return (
    <div className="settings-frame">
      <table className="settings-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Browser</th>
            <th scope="col">Signed in</th>
            <th scope="col">Last seen</th>
            <th scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="font-medium text-ink">{row.browser}</td>
              <td data-label="Signed in">{dayWords(row.createdAt, true)}</td>
              <td data-label="Last seen">{row.current ? 'Now' : usedWords(row.lastSeenAt, now)}</td>
              <td className="text-end">{action(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EverywhereDialog({
  sessions,
  onClose,
  onDone,
}: {
  sessions: readonly { readonly id: string; readonly browser: string }[];
  onClose: () => void;
  onDone: (revoked: number) => void;
}): ReactNode {
  const { act } = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const others = sessions.length;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    const done = await act('Signing out your other sessions', () => signOutOthers());
    setBusy(false);
    if (done.ok) onDone(done.value);
    else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Sign out everywhere else?"
      description="This browser stays signed in."
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button data-autofocus="" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            busyLabel="Signing out"
            onClick={() => void confirm()}
          >
            {others === 0 ? 'Sign out' : `Sign out ${plural(others, 'session')}`}
          </Button>
        </>
      )}
    >
      {others === 0 ? null : (
        <ul className="border-t border-rule">
          {sessions.map((session) => (
            <li key={session.id} className="flex justify-between gap-12 border-b border-rule py-8">
              <span>{session.browser}</span>
              <span className="text-caption text-secondary">signs in again</span>
            </li>
          ))}
        </ul>
      )}
      <p>Each one has to sign in again the next time it is used. Nothing else changes.</p>
    </Dialog>
  );
}

export function SessionsScreen({
  sessions,
  now,
  everywhere = false,
}: {
  sessions: readonly SessionRow[];
  now: string;
  everywhere?: boolean;
}): ReactNode {
  const { act, complain, refresh } = useSettings();
  const [gone, setGone] = useState<readonly string[]>([]);
  const [asking, setAsking] = useState(everywhere);
  const live = sessions.filter((session) => !gone.includes(session.id));
  const here = live.filter((session) => session.current);
  const others = live.filter((session) => !session.current);

  async function signOut(row: SessionRow) {
    setGone((ids) => [...ids, row.id]);
    const done = await act('Signing out a session', () => signOutSession(row.id));
    if (done.ok) {
      toast({ title: `${row.browser} is signed out.`, description: 'This cannot be undone.' });
      refresh();
      return;
    }
    setGone((ids) => ids.filter((id) => id !== row.id));
    if (!wasCancelled(done)) complain(`Could not sign out ${row.browser}.`, done.problem);
  }

  const claim =
    others.length === 0
      ? 'Signed in on this browser only.'
      : `Signed in on ${plural(live.length, 'browser')}.`;

  return (
    <SettingsPage width="work">
      <PageHead
        size="calm"
        label="Your account"
        claim={claim}
        rest={
          others.length === 0 ? 'Nothing else to review.' : 'Sign out any you do not recognise.'
        }
        {...(others.length === 0
          ? {}
          : {
              actions: (
                <Button
                  icon={<IconSignOut />}
                  onClick={() => {
                    setAsking(true);
                  }}
                >
                  Sign out everywhere else
                </Button>
              ),
            })}
      />
      <section aria-labelledby="sessions-this" className="flex flex-col gap-8">
        <SectionHead id="sessions-this">This browser</SectionHead>
        <Table
          caption="This browser"
          rows={here}
          now={now}
          action={() => (
            <form method="post" action="/sign-out">
              <Button type="submit" variant="quiet" size="sm">
                Sign out
              </Button>
            </form>
          )}
        />
      </section>
      <section aria-labelledby="sessions-others" className="flex flex-col gap-8">
        <SectionHead id="sessions-others">
          Other browsers{' '}
          <span data-numeric="" className="font-regular text-secondary">
            {others.length}
          </span>
        </SectionHead>
        {others.length === 0 ? (
          <p className="text-caption text-secondary">
            No other browser is signed in to your account.
          </p>
        ) : (
          <Table
            caption="Other browsers"
            rows={others}
            now={now}
            action={(row) => (
              <Button
                size="sm"
                aria-label={`Sign out ${row.browser}`}
                onClick={() => void signOut(row)}
              >
                Sign out
              </Button>
            )}
          />
        )}
      </section>
      <Fine>
        A session ends after 7 days without use, or 30 days after it signed in. We keep the browser
        name only: no IP address, no location.
      </Fine>
      {asking ? (
        <EverywhereDialog
          sessions={others}
          onClose={() => {
            setAsking(false);
          }}
          onDone={(revoked) => {
            setAsking(false);
            setGone((ids) => [...ids, ...others.map((session) => session.id)]);
            toast({ title: `Signed out ${plural(revoked, 'other session')}.` });
            refresh();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
