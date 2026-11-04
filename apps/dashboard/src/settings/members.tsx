'use client';
import {
  Button,
  ButtonLink,
  Dialog,
  IconLock,
  IconPlus,
  Select,
  SelectOption,
  toast,
} from '@drefyn/ui/react';
import type { OrgRole } from '@drefyn/auth/permissions';
import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import {
  changeMemberRole,
  keysOfMember,
  removeMember,
  resendInvitation,
  withdrawInvitation,
} from '../server/settings-actions.ts';
import { FilterBar, FilterMenu, SearchBox } from './filters.tsx';
import {
  dayWords,
  filterPeople,
  invitePermit,
  plural,
  projectAccessWords,
  roleLabel,
  ROLE_DESCRIPTIONS,
  roleOptions,
  seatSentence,
  type PeopleFilter,
  type PeopleSort,
  type PeopleStatus,
  type PersonRow,
  type Seats,
} from './models.ts';
import { Fine, Meter, PageHead, PageNotice, SectionHead, SettingsPage } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords, type KeyToRevoke } from './results.ts';

const InviteDialog = dynamic(() => import('./invite-dialog.tsx').then((m) => m.InviteDialog), {
  ssr: false,
});
const AccessDialog = dynamic(() => import('./access-dialog.tsx').then((m) => m.AccessDialog), {
  ssr: false,
});

type DefaultRole = 'editor' | 'viewer' | null;

export interface MemberRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultRole;
  readonly joinedAt: string;
  readonly self: boolean;
  readonly projectRoles: readonly { readonly projectId: string; readonly role: string }[];
}

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultRole;
  readonly invitedBy: string;
  readonly expiresAt: string;
  readonly expired: boolean;
}

export interface ProjectChoice {
  readonly id: string;
  readonly name: string;
  readonly product: string;
}

export interface MembersFacts {
  readonly org: string;
  readonly organization: string;
  readonly actorRole: OrgRole;
  readonly manage: boolean;
  readonly members: readonly MemberRow[];
  readonly invitations: readonly InvitationRow[];
  readonly projects: readonly ProjectChoice[];
  readonly seats: Seats;
  readonly now: string;
}

export type MembersOverlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'invite' }
  | { readonly kind: 'access'; readonly member: string }
  | {
      readonly kind: 'remove';
      readonly member: string;
      readonly keys: readonly KeyToRevoke[];
      readonly more: boolean;
    };

const STATUS_WORDS: Readonly<Record<PeopleStatus, string>> = {
  active: 'Active',
  invited: 'Invited',
  expired: 'Expired',
};
const SORT_WORDS: Readonly<Record<PeopleSort, string>> = {
  name: 'Name, A to Z',
  role: 'Role',
  newest: 'Joined, newest first',
  oldest: 'Joined, oldest first',
};
const SORT_SHORT: Readonly<Record<PeopleSort, string>> = {
  name: 'Name',
  role: 'Role',
  newest: 'Newest',
  oldest: 'Oldest',
};
const ROLE_ARTICLE: Readonly<Record<OrgRole, string>> = {
  owner: 'an owner',
  admin: 'an admin',
  member: 'a member',
};
const PAGE_SIZE = 50;
const BASE_FILTER: PeopleFilter = {
  search: '',
  roles: [],
  statuses: ['active', 'invited'],
  sort: 'name',
};

function statusValue(statuses: readonly PeopleStatus[]): string {
  const words = statuses.map((status) => STATUS_WORDS[status].toLowerCase()).join(', ');
  return words === '' ? 'None' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

function RemoveDialog({
  org,
  organization,
  member,
  keys,
  more,
  onClose,
  onRemoved,
}: {
  org: string;
  organization: string;
  member: MemberRow;
  keys: readonly KeyToRevoke[];
  more: boolean;
  onClose: () => void;
  onRemoved: (revoked: number) => void;
}): ReactNode {
  const { act } = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const first = firstName(member.name);

  async function confirm() {
    setBusy(true);
    setError(undefined);
    const done = await act('Removing someone', () => removeMember(org, member.id));
    setBusy(false);
    if (done.ok) onRemoved(done.value);
    else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove ${member.name} from ${organization}?`}
      description={`${first} loses access to every ${organization} project right away. You can invite ${first} again later.`}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button data-autofocus="" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} busyLabel="Removing" onClick={() => void confirm()}>
            {keys.length === 0
              ? `Remove ${first}`
              : `Remove ${first} and revoke ${plural(keys.length, 'key')}`}
          </Button>
        </>
      )}
    >
      {keys.length === 0 ? (
        <p>{first} has created no API keys that still work.</p>
      ) : (
        <>
          <p>
            {first} created {plural(keys.length, 'API key')}. Removing {first} revokes{' '}
            {keys.length === 1 ? 'it' : 'them'}, and anything that uses{' '}
            {keys.length === 1 ? 'it' : 'them'} stops working:
          </p>
          <ul aria-label="Keys that will be revoked" className="border-t border-rule">
            {keys.map((key) => (
              <li key={key.keyId} className="flex justify-between gap-12 border-b border-rule py-8">
                <span>
                  <b className="font-medium text-ink">{key.name}</b>{' '}
                  <span className="font-mono text-caption">drf_ak_...{key.suffix}</span>
                </span>
                <span className="text-caption text-secondary">
                  {key.lastUsedAt === null ? 'never used' : 'in use'}
                </span>
              </li>
            ))}
          </ul>
          {more ? <Fine>And more. Every key {first} created is revoked.</Fine> : null}
        </>
      )}
      <Fine>This cannot be undone. Every owner of {organization} gets an email about it.</Fine>
    </Dialog>
  );
}

function RoleCell({
  facts,
  member,
  role,
  lastOwner,
  onChange,
}: {
  facts: MembersFacts;
  member: MemberRow;
  role: OrgRole;
  lastOwner: boolean;
  onChange: (role: OrgRole) => void;
}): ReactNode {
  if (!facts.manage) return roleLabel(role);
  const options = roleOptions(
    { actor: facts.actorRole, target: role, self: member.self, lastOwner },
    facts.organization,
  );
  return (
    <div className="w-full max-w-128">
      <Select
        label={`Role for ${member.name}`}
        labelHidden
        value={role}
        onChange={(next) => {
          onChange(next as OrgRole);
        }}
      >
        {options.map((option) => (
          <SelectOption
            key={option.role}
            value={option.role}
            description={option.reason ?? ROLE_DESCRIPTIONS[option.role]}
            disabled={option.reason !== undefined}
          >
            {roleLabel(option.role)}
          </SelectOption>
        ))}
      </Select>
    </div>
  );
}

export function MembersScreen({
  facts,
  overlay = { kind: 'none' },
  initialFilter = BASE_FILTER,
}: {
  facts: MembersFacts;
  overlay?: MembersOverlay;
  initialFilter?: PeopleFilter;
}): ReactNode {
  const { act, complain, refresh } = useSettings();
  const [open, setOpen] = useState<MembersOverlay>(overlay);
  const [filter, setFilter] = useState(initialFilter);
  const [roles, setRoles] = useState<Readonly<Record<string, OrgRole>>>({});
  const [gone, setGone] = useState<readonly string[]>([]);
  const [everyone, setEveryone] = useState(false);
  const { org, organization, seats } = facts;
  const members = facts.members.filter((m) => !gone.includes(m.id));
  const invitations = facts.invitations.filter((i) => !gone.includes(i.id));
  const waiting = invitations.filter((i) => !i.expired);
  const roleOf = (member: MemberRow) => roles[member.id] ?? member.role;
  const owners = members.filter((m) => roleOf(m) === 'owner').length;
  const sentence = seatSentence(organization, members.length, waiting.length, seats);
  const permit = invitePermit(seats);
  const rows: (PersonRow & { readonly source: MemberRow | InvitationRow })[] = [
    ...members.map((m) => ({
      id: m.id,
      kind: 'member' as const,
      name: m.name,
      email: m.email,
      role: roleOf(m),
      at: m.joinedAt,
      source: m,
    })),
    ...invitations.map((i) => ({
      id: i.id,
      kind: i.expired ? ('expired' as const) : ('invited' as const),
      name: i.email,
      email: i.email,
      role: i.role,
      at: i.expiresAt,
      source: i,
    })),
  ];
  const shown = filterPeople(rows, filter);
  const peopleShown = shown.filter((row) => row.kind === 'member');
  const invitationsShown = shown.filter((row) => row.kind !== 'member');
  const visible = everyone ? peopleShown : peopleShown.slice(0, PAGE_SIZE);
  const filtered = filter !== initialFilter && filter !== BASE_FILTER;
  const total = rows.filter((row) => row.kind !== 'expired').length;

  async function change(member: MemberRow, next: OrgRole) {
    const before = roleOf(member);
    if (next === before) return;
    setRoles((held) => ({ ...held, [member.id]: next }));
    const done = await act('Changing a role', () => changeMemberRole(org, member.id, next));
    if (!done.ok) {
      setRoles((held) => ({ ...held, [member.id]: before }));
      if (!wasCancelled(done)) complain(`Could not change ${member.name}'s role.`, done.problem);
      return;
    }
    const { revokedKeys } = done.value;
    toast({
      title: `${member.name} is now ${ROLE_ARTICLE[next]}.`,
      ...(revokedKeys === 0
        ? {}
        : {
            description: `${plural(revokedKeys, 'API key')} they created ${
              revokedKeys === 1 ? 'was' : 'were'
            } revoked. Undo restores the role, not the ${revokedKeys === 1 ? 'key' : 'keys'}.`,
          }),
      undo: async () => {
        const undone = await act('Changing a role', () => changeMemberRole(org, member.id, before));
        if (!undone.ok) throw new Error('role not restored');
        setRoles((held) => ({ ...held, [member.id]: before }));
        refresh();
      },
    });
    refresh();
  }

  async function askToRemove(member: MemberRow) {
    const read = await act('Removing someone', () => keysOfMember(org, member.id));
    if (read.ok) {
      setOpen({ kind: 'remove', member: member.id, keys: read.value.keys, more: read.value.more });
    } else if (!wasCancelled(read)) {
      complain(`Could not check ${member.name}'s keys.`, read.problem);
    }
  }

  async function withdraw(invitation: InvitationRow) {
    setGone((ids) => [...ids, invitation.id]);
    const done = await act('Withdrawing an invitation', () =>
      withdrawInvitation(org, invitation.id),
    );
    if (!done.ok && !(done.problem.kind === 'refused' && done.problem.code === 'AUTH_NOT_FOUND')) {
      setGone((ids) => ids.filter((id) => id !== invitation.id));
      if (!wasCancelled(done)) complain('Could not withdraw that invitation.', done.problem);
      return;
    }
    toast({
      title: `Invitation to ${invitation.email} withdrawn.`,
      description: 'Its link stopped working, and its seat is free.',
      undo: async () => {
        const again = await act('Inviting someone', () =>
          resendInvitation(org, {
            email: invitation.email,
            role: invitation.role,
            defaultProjectRole: invitation.defaultProjectRole,
          }),
        );
        if (!again.ok) throw new Error('not invited again');
        setGone((ids) => ids.filter((id) => id !== invitation.id));
        refresh();
      },
    });
    refresh();
  }

  async function resend(invitation: InvitationRow) {
    const done = await act('Inviting someone', () =>
      resendInvitation(org, {
        email: invitation.email,
        role: invitation.role,
        defaultProjectRole: invitation.defaultProjectRole,
      }),
    );
    if (done.ok) {
      toast({
        title: `Invitation sent again to ${invitation.email}.`,
        description: 'The older link stopped working.',
      });
      refresh();
    } else if (!wasCancelled(done)) {
      complain('Could not send that invitation.', done.problem);
    }
  }

  const statusCount = (status: PeopleStatus) =>
    rows.filter(
      (row) =>
        (status === 'active' && row.kind === 'member') ||
        (status === 'invited' && row.kind === 'invited') ||
        (status === 'expired' && row.kind === 'expired'),
    ).length;
  const roleCount = (role: OrgRole) => rows.filter((row) => row.role === role).length;
  const person = (id: string) => members.find((m) => m.id === id);
  const removing = open.kind === 'remove' ? person(open.member) : undefined;
  const editing = open.kind === 'access' ? person(open.member) : undefined;

  return (
    <SettingsPage width="work">
      <PageHead
        label={organization}
        claim={sentence.claim}
        rest={sentence.rest}
        {...(facts.manage
          ? {
              actions: (
                <Button
                  variant="primary"
                  icon={<IconPlus />}
                  disabled={!permit.allowed}
                  aria-describedby={permit.allowed ? undefined : 'seat-why'}
                  onClick={() => {
                    setOpen({ kind: 'invite' });
                  }}
                >
                  Invite people
                </Button>
              ),
            }
          : {})}
      />
      {seats.state === 'over' ? (
        <PageNotice
          icon={<IconLock />}
          title="Everyone keeps access. Nothing was deleted."
          actions={
            facts.manage ? (
              <ButtonLink size="sm" href={`/${org}/settings/plan`}>
                Change plan
              </ButtonLink>
            ) : undefined
          }
        >
          {organization} uses {seats.words} seats, so new invitations are paused.
        </PageNotice>
      ) : null}
      <div className="flex flex-col gap-4">
        <Meter label="Seats" value={seats.used} max={seats.limit} words={seats.words} />
        {facts.manage ? (
          <Fine id="seat-why">
            {permit.allowed
              ? 'One seat per person, whichever products they use. A waiting invitation holds a seat until it is accepted or expires.'
              : permit.reason}
          </Fine>
        ) : (
          <Fine>Only owners and admins can invite people or change roles.</Fine>
        )}
      </div>
      <FilterBar
        label="Filter and sort people"
        count={
          filtered
            ? `${String(shown.length)} of ${String(total)} shown`
            : `${String(shown.length)} shown`
        }
      >
        <SearchBox
          label="Search by name or email"
          value={filter.search}
          onChange={(search) => {
            setFilter((now) => ({ ...now, search }));
          }}
        />
        <FilterMenu
          label="Role"
          mode="multiple"
          value={filter.roles.length === 0 ? 'Any' : filter.roles.map(roleLabel).join(', ')}
          selected={filter.roles}
          choices={(['owner', 'admin', 'member'] as const).map((role) => ({
            id: role,
            label: roleLabel(role),
            meta: String(roleCount(role)),
          }))}
          onChange={(ids) => {
            setFilter((now) => ({ ...now, roles: ids as OrgRole[] }));
          }}
        />
        <FilterMenu
          label="Status"
          mode="multiple"
          value={statusValue(filter.statuses)}
          selected={filter.statuses}
          choices={(Object.keys(STATUS_WORDS) as PeopleStatus[])
            .filter((status) => facts.manage || status === 'active')
            .map((status) => ({
              id: status,
              label: STATUS_WORDS[status],
              meta: String(statusCount(status)),
            }))}
          onChange={(ids) => {
            setFilter((now) => ({ ...now, statuses: ids as PeopleStatus[] }));
          }}
        />
        <FilterMenu
          label="Sort"
          mode="single"
          value={SORT_SHORT[filter.sort]}
          selected={[filter.sort]}
          choices={(Object.keys(SORT_WORDS) as PeopleSort[]).map((sort) => ({
            id: sort,
            label: SORT_WORDS[sort],
          }))}
          onChange={(ids) => {
            const [sort] = ids;
            if (sort !== undefined) setFilter((now) => ({ ...now, sort: sort as PeopleSort }));
          }}
        />
        {filtered ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setFilter(BASE_FILTER);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </FilterBar>
      {shown.length === 0 ? (
        <div className="py-16">
          <p className="font-medium text-ink">
            {filter.search.trim() === ''
              ? `No one in ${organization} matches these filters.`
              : `No one in ${organization} matches ${filter.search.trim()}.`}
          </p>
          <Fine>
            Search looks at names and addresses. Try part of an address, or clear the filters.
          </Fine>
        </div>
      ) : null}
      {peopleShown.length === 0 ? null : (
        <section aria-labelledby="members-people" className="flex flex-col gap-8">
          <SectionHead id="members-people">People</SectionHead>
          <div className="settings-frame">
            <table className="settings-table">
              <caption className="sr-only">People in {organization}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Joined</th>
                  {facts.manage ? (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ source }) => {
                  const member = source as MemberRow;
                  const role = roleOf(member);
                  const lastOwner = role === 'owner' && owners === 1;
                  return (
                    <tr key={member.id}>
                      <td>
                        <span className="flex flex-col">
                          <span className="font-medium text-ink">
                            {member.name}
                            {member.self ? (
                              <span className="font-regular text-caption text-secondary">
                                {' '}
                                (you)
                              </span>
                            ) : null}
                          </span>
                          <span className="text-caption text-secondary">{member.email}</span>
                        </span>
                      </td>
                      <td data-label="Role">
                        <RoleCell
                          facts={facts}
                          member={member}
                          role={role}
                          lastOwner={lastOwner}
                          onChange={(next) => void change(member, next)}
                        />
                      </td>
                      <td data-wide="">
                        {projectAccessWords(
                          role,
                          member.defaultProjectRole,
                          member.projectRoles.map((r) => r.role),
                        )}
                      </td>
                      <td data-wide="">{dayWords(member.joinedAt)}</td>
                      {facts.manage ? (
                        <td className="whitespace-nowrap sm:text-end">
                          {role === 'member' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              aria-label={`Projects for ${member.name}`}
                              onClick={() => {
                                setOpen({ kind: 'access', member: member.id });
                              }}
                            >
                              Projects
                            </Button>
                          ) : null}
                          {member.self || lastOwner ? null : (
                            <Button
                              variant="quiet"
                              size="sm"
                              aria-label={`Remove ${member.name}`}
                              onClick={() => void askToRemove(member)}
                            >
                              Remove
                            </Button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length < peopleShown.length ? (
              <div className="flex items-center justify-between gap-12 border-t border-rule px-12 py-8">
                <span data-numeric="" className="text-caption text-secondary">
                  Showing {visible.length} of {peopleShown.length}
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setEveryone(true);
                  }}
                >
                  Show all
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      )}
      {invitationsShown.length === 0 ? null : (
        <section aria-labelledby="members-waiting" className="flex flex-col gap-8">
          <SectionHead id="members-waiting">Invitations waiting</SectionHead>
          <div className="settings-frame">
            <table className="settings-table">
              <caption className="sr-only">Invitations waiting</caption>
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Role</th>
                  <th scope="col">Invited by</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitationsShown.map(({ source }) => {
                  const invitation = source as InvitationRow;
                  return (
                    <tr key={invitation.id}>
                      <td className="font-medium text-ink">{invitation.email}</td>
                      <td data-label="Role">
                        {roleLabel(invitation.role)}
                        {invitation.defaultProjectRole === null
                          ? ''
                          : `, ${invitation.defaultProjectRole}`}
                      </td>
                      <td data-wide="">{invitation.invitedBy}</td>
                      <td data-label="Expires">
                        {invitation.expired ? 'Expired' : dayWords(invitation.expiresAt)}
                      </td>
                      <td className="whitespace-nowrap sm:text-end">
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Resend invitation to ${invitation.email}`}
                          onClick={() => void resend(invitation)}
                        >
                          Resend
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Withdraw invitation to ${invitation.email}`}
                          onClick={() => void withdraw(invitation)}
                        >
                          Withdraw
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {facts.manage ? (
        <Fine>
          Removing someone revokes the API keys they created. You see which ones before anything
          happens.
        </Fine>
      ) : null}
      {open.kind === 'invite' ? (
        <InviteDialog
          org={org}
          organization={organization}
          actorRole={facts.actorRole}
          seats={seats}
          onClose={() => {
            setOpen({ kind: 'none' });
          }}
          onSent={() => {
            refresh();
          }}
        />
      ) : null}
      {open.kind === 'remove' && removing !== undefined ? (
        <RemoveDialog
          org={org}
          organization={organization}
          member={removing}
          keys={open.keys}
          more={open.more}
          onClose={() => {
            setOpen({ kind: 'none' });
          }}
          onRemoved={(revoked) => {
            setOpen({ kind: 'none' });
            setGone((ids) => [...ids, removing.id]);
            toast({
              title: `${removing.name} was removed.`,
              ...(revoked === 0
                ? {}
                : { description: `${plural(revoked, 'API key')} revoked. This cannot be undone.` }),
            });
            refresh();
          }}
        />
      ) : null}
      {open.kind === 'access' && editing !== undefined ? (
        <AccessDialog
          org={org}
          member={editing}
          projects={facts.projects}
          onClose={() => {
            setOpen({ kind: 'none' });
          }}
          onSaved={() => {
            setOpen({ kind: 'none' });
            toast({ title: `Project access saved for ${editing.name}.` });
            refresh();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
