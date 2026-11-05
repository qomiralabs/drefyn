'use client';
import {
  Button,
  ButtonLink,
  Dialog,
  Radio,
  RadioGroup,
  Select,
  SelectOption,
  TagField,
  toast,
} from '@drefyn/ui/react';
import type { OrgRole } from '@drefyn/auth/permissions';
import { useState, type ReactNode } from 'react';
import { sendInvitations } from '../server/settings-actions.ts';
import { plural, roleLabel, ROLE_DESCRIPTIONS, type Seats } from './models.ts';
import { Fine } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords, type InviteResult } from './results.ts';

type Access = 'editor' | 'viewer' | 'none';

const ACCESS: readonly (readonly [Access, string, string])[] = [
  [
    'editor',
    'Editor on every project',
    'Writes and publishes in every project, including new ones.',
  ],
  ['viewer', 'Viewer on every project', 'Reads every project.'],
  ['none', 'No projects until I choose', 'Joins with no project. You add them later.'],
];

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resultWords(row: InviteResult, organization: string): string {
  switch (row.result) {
    case 'sent':
      return 'Sent';
    case 'member':
      return `is already in ${organization}.`;
    case 'blocked':
      return `asked not to receive invitations from ${organization}. No seat is used.`;
    case 'limit':
      return 'was not sent. There are no seats left.';
    case 'invalid':
      return 'is not a full address.';
    case 'waiting':
      return 'was not tried.';
    case 'failed':
      return 'was not sent. Try again.';
  }
}

export function InviteDialog({
  org,
  organization,
  actorRole,
  seats,
  results: seededResults = null,
  initial = [],
  onClose,
  onSent,
}: {
  org: string;
  organization: string;
  actorRole: OrgRole;
  seats: Seats;
  results?: readonly InviteResult[] | null;
  initial?: readonly string[];
  onClose: () => void;
  onSent: () => void;
}): ReactNode {
  const { act } = useSettings();
  const [emails, setEmails] = useState<readonly string[]>(initial);
  const [role, setRole] = useState<OrgRole>('member');
  const [access, setAccess] = useState<Access>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [results, setResults] = useState<readonly InviteResult[] | null>(seededResults);

  const bad = emails.filter((email) => !ADDRESS.test(email));
  const after = seats.used + emails.length;
  const failed = results?.filter((row) => row.result !== 'sent').length ?? 0;

  async function send() {
    if (emails.length === 0 || bad.length > 0) return;
    setBusy(true);
    setError(undefined);
    const done = await act(role === 'owner' ? 'Inviting an owner' : 'Inviting someone', () =>
      sendInvitations(org, {
        emails,
        role,
        defaultProjectRole: role !== 'member' || access === 'none' ? null : access,
      }),
    );
    setBusy(false);
    if (!done.ok) {
      if (!wasCancelled(done)) setError(problemWords(done.problem));
      return;
    }
    const sent = done.value.filter((row) => row.result === 'sent').length;
    if (sent > 0) onSent();
    if (sent === done.value.length) {
      toast({
        title: `${plural(sent, 'invitation')} sent.`,
        description: 'Each link works for 7 days.',
      });
      onClose();
      return;
    }
    setResults(done.value);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Invite people to ${organization}`}
      description="Each person gets an email with a link that works for 7 days."
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>{results === null ? 'Cancel' : 'Close'}</Button>
          {results === null ? (
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Sending"
              disabled={emails.length === 0 || bad.length > 0}
              onClick={() => void send()}
            >
              {emails.length === 0
                ? 'Send invitations'
                : `Send ${plural(emails.length, 'invitation')}`}
            </Button>
          ) : null}
        </>
      )}
    >
      {results === null ? (
        <>
          <TagField
            label="Email addresses"
            tagsLabel="Addresses to invite"
            inputMode="email"
            description="Type or paste addresses. Enter or a comma adds each one."
            value={emails}
            onChange={setEmails}
            tagErrors={Object.fromEntries(bad.map((email) => [email, 'Not a full address.']))}
            {...(bad.length === 0
              ? {}
              : {
                  error: `Fix or remove the ${plural(bad.length, 'marked address', 'marked addresses')} to send.`,
                })}
          />
          <RadioGroup
            label="Role"
            value={role}
            onChange={(next) => {
              setRole(next as OrgRole);
            }}
          >
            {(['owner', 'admin', 'member'] as const).map((choice) => (
              <Radio
                key={choice}
                value={choice}
                disabled={choice === 'owner' && actorRole !== 'owner'}
                description={
                  choice === 'owner' && actorRole !== 'owner'
                    ? 'Only an owner can make someone an owner.'
                    : ROLE_DESCRIPTIONS[choice]
                }
              >
                {roleLabel(choice)}
              </Radio>
            ))}
          </RadioGroup>
          {role === 'member' ? (
            <Select
              label="Access to projects"
              value={access}
              onChange={(next) => {
                setAccess(next as Access);
              }}
            >
              {ACCESS.map(([value, label, description]) => (
                <SelectOption key={value} value={value} description={description}>
                  {label}
                </SelectOption>
              ))}
            </Select>
          ) : null}
          {emails.length === 0 ? null : (
            <p data-numeric="" className="text-caption text-secondary">
              Uses {plural(emails.length, 'seat')}.
              {seats.limit === null
                ? ''
                : ` ${String(after)} of ${String(seats.limit)} after this.`}
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            {failed === results.length
              ? 'No invitations were sent.'
              : `${String(failed)} of ${String(results.length)} invitations were not sent. The rest went out.`}
          </p>
          <ul aria-label="What happened to each address" className="border-t border-rule">
            {results.map((row) => (
              <li key={row.email} className="flex justify-between gap-12 border-b border-rule py-8">
                <span>
                  {row.email}{' '}
                  {row.result === 'sent' ? null : (
                    <span className="text-caption text-secondary">
                      {resultWords(row, organization)}
                    </span>
                  )}
                </span>
                <span className="text-caption text-secondary">
                  {row.result === 'sent' ? 'Sent' : 'Not sent'}
                </span>
              </li>
            ))}
          </ul>
          {results.some((row) => row.result === 'limit') ? (
            <Fine>
              <ButtonLink variant="quiet" size="sm" href={`/${org}/settings/plan`}>
                Change plan
              </ButtonLink>
            </Fine>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
