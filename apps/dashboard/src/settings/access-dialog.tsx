'use client';
import { Button, Dialog, Select, SelectOption } from '@drefyn/ui/react';
import type { ProjectRole } from '@drefyn/auth/permissions';
import { useState, type ReactNode } from 'react';
import { saveProjectAccess } from '../server/settings-actions.ts';
import type { MemberRow, ProjectChoice } from './members.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords } from './results.ts';

type Fallback = 'editor' | 'viewer' | 'none';
type Choice = 'same' | ProjectRole;

const FALLBACK_LABELS: Readonly<Record<Fallback, string>> = {
  editor: 'Editor',
  viewer: 'Viewer',
  none: 'No access',
};

const ROLE_OPTIONS: readonly (readonly [ProjectRole, string, string])[] = [
  ['admin', 'Admin', 'Manages the project, its settings and who can edit it.'],
  ['editor', 'Editor', 'Writes, edits and publishes.'],
  ['viewer', 'Viewer', 'Reads only.'],
];

export function AccessDialog({
  org,
  member,
  projects,
  onClose,
  onSaved,
}: {
  org: string;
  member: MemberRow;
  projects: readonly ProjectChoice[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { act } = useSettings();
  const start: Fallback = member.defaultProjectRole ?? 'none';
  const held = new Map(member.projectRoles.map((r) => [r.projectId, r.role as ProjectRole]));
  const [fallback, setFallback] = useState<Fallback>(start);
  const [choices, setChoices] = useState<ReadonlyMap<string, Choice>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const first = member.name.split(/\s+/)[0] ?? member.name;

  async function save() {
    setBusy(true);
    setError(undefined);
    const changes = [...choices].flatMap(([projectId, choice]) => {
      const role = choice === 'same' ? null : choice;
      return role === (held.get(projectId) ?? null) ? [] : [{ projectId, role }];
    });
    const done = await act('Changing project access', () =>
      saveProjectAccess(org, member.id, {
        ...(fallback === start ? {} : { fallback: fallback === 'none' ? null : fallback }),
        changes,
      }),
    );
    setBusy(false);
    if (done.ok) onSaved();
    else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  const sameWords = `Same as every project (${FALLBACK_LABELS[fallback]})`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Project access for ${member.name}`}
      description={`${first} is a member, so these apply. Owners and admins manage every project.`}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
            Save access
          </Button>
        </>
      )}
    >
      <Select
        label="Every project, unless set below"
        value={fallback}
        onChange={(next) => {
          setFallback(next as Fallback);
        }}
      >
        <SelectOption value="editor" description="Writes and publishes.">
          Editor
        </SelectOption>
        <SelectOption value="viewer" description="Reads only.">
          Viewer
        </SelectOption>
        <SelectOption value="none" description="Opens only the projects set below.">
          No access
        </SelectOption>
      </Select>
      {projects.length === 0 ? (
        <p className="text-caption text-secondary">There are no projects yet.</p>
      ) : (
        <ul aria-label="Access per project" className="border-t border-rule">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-wrap items-center justify-between gap-8 border-b border-rule py-8"
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-ink">{project.name}</span>
                <span className="text-caption text-secondary">{project.product}</span>
              </span>
              <div className="w-full sm:w-shell-nav">
                <Select
                  label={`Access to ${project.name}`}
                  labelHidden
                  value={choices.get(project.id) ?? held.get(project.id) ?? 'same'}
                  onChange={(next) => {
                    setChoices((now) => new Map(now).set(project.id, next as Choice));
                  }}
                >
                  <SelectOption value="same">{sameWords}</SelectOption>
                  {ROLE_OPTIONS.map(([value, label, description]) => (
                    <SelectOption key={value} value={value} description={description}>
                      {label}
                    </SelectOption>
                  ))}
                </Select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
