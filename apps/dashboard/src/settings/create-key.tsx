'use client';
import {
  Button,
  Checkbox,
  Dialog,
  MultiCombobox,
  Radio,
  RadioGroup,
  Select,
  SelectOption,
  TextField,
} from '@drefyn/ui/react';
import { API_KEY_SCOPES } from '@drefyn/auth/permissions';
import { useEffect, useId, useMemo, useState, type SyntheticEvent, type ReactNode } from 'react';
import { createKey } from '../server/settings-actions.ts';
import { dayWords, PRODUCT_LABELS, projectWords, scopeWords, type Product } from './models.ts';
import { Fine } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords, type MadeKey } from './results.ts';

const DAY_MS = 86_400_000;
const EXPIRY: readonly (readonly [string, number | null])[] = [
  ['In 30 days', 30],
  ['In 90 days, suggested', 90],
  ['In 1 year', 365],
  ['Never', null],
];

export function CreateKeyDialog({
  org,
  organization,
  projects,
  grantable,
  now,
  onClose,
  onMade,
}: {
  org: string;
  organization: string;
  projects: readonly { readonly id: string; readonly name: string }[];
  grantable: readonly string[];
  now: string;
  onClose: () => void;
  onMade: (key: MadeKey) => void;
}): ReactNode {
  const { act } = useSettings();
  // One per opening, so a retried press cannot mint a second key.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [projectScope, setProjectScope] = useState<'all' | 'listed'>('all');
  const [projectIds, setProjectIds] = useState<readonly string[]>([]);
  const [expiry, setExpiry] = useState('In 90 days, suggested');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const groupId = useId();
  const days = EXPIRY.find(([label]) => label === expiry)?.[1] ?? null;
  const ready =
    name.trim() !== '' && scopes.length > 0 && (projectScope === 'all' || projectIds.length > 0);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    setNameError(undefined);
    const done = await act('Creating an API key', () =>
      createKey(org, {
        name,
        scopes,
        projectScope,
        projectIds: projectScope === 'listed' ? projectIds : [],
        expiresInDays: days,
        idempotencyKey,
      }),
    );
    setBusy(false);
    if (done.ok) {
      onMade(done.value);
      return;
    }
    if (done.problem.kind === 'refused' && done.problem.code === 'AUTH_IDEMPOTENCY_REPLAY') {
      setError(
        'This key was already created, and it is shown only once. Revoke it and make a new one.',
      );
    } else if (done.problem.kind === 'refused' && done.problem.code === 'AUTH_INPUT_INVALID') {
      setNameError('Use up to 100 characters, with no web addresses.');
    } else if (!wasCancelled(done)) {
      setError(problemWords(done.problem));
    }
  }

  const products = Object.keys(PRODUCT_LABELS) as Product[];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Create an API key"
      description="You see the key once, right after this."
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="create-key"
            busy={busy}
            busyLabel="Creating"
            disabled={!ready}
          >
            Create key
          </Button>
        </>
      )}
    >
      <form
        id="create-key"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-16"
      >
        <TextField
          id="key-name"
          label="Name"
          description="Where it is used, like ci-deploy."
          spellCheck={false}
          autoComplete="off"
          value={name}
          onChange={setName}
          maxLength={100}
          required
          {...(nameError === undefined ? {} : { error: nameError })}
        />
        <div role="group" aria-labelledby={groupId} className="flex flex-col gap-8">
          <span id={groupId} className="text-body-s font-medium text-body">
            What it can do
          </span>
          <div className="grid gap-12 sm:grid-cols-3">
            {products.map((product) => (
              <fieldset key={product} className="flex flex-col gap-4">
                <legend className="text-caption text-secondary">{PRODUCT_LABELS[product]}</legend>
                {API_KEY_SCOPES.filter((scope) => scope.product === product).map((scope) => (
                  <Checkbox
                    key={scope.scope}
                    disabled={!grantable.includes(scope.scope)}
                    checked={scopes.includes(scope.scope)}
                    onChange={(checked) => {
                      setScopes((now) =>
                        checked ? [...now, scope.scope] : now.filter((s) => s !== scope.scope),
                      );
                    }}
                  >
                    {scope.label}
                  </Checkbox>
                ))}
              </fieldset>
            ))}
          </div>
          <Fine>
            A key can only do what you can do. No key can manage people, keys, billing or settings.
          </Fine>
        </div>
        <RadioGroup
          label="Projects"
          value={projectScope}
          onChange={(next) => {
            setProjectScope(next as 'all' | 'listed');
          }}
        >
          <Radio value="all" description="Including projects made later.">
            All projects
          </Radio>
          <Radio
            value="listed"
            disabled={projects.length === 0}
            description={
              projects.length === 0
                ? `${organization} has no projects yet.`
                : 'A deleted project is never replaced by another.'
            }
          >
            Only these projects
          </Radio>
        </RadioGroup>
        {projectScope === 'listed' ? (
          <MultiCombobox
            label="Projects for this key"
            tagsLabel="Chosen projects"
            placeholder="Search projects"
            value={projectIds}
            onChange={setProjectIds}
          >
            {projects.map((project) => (
              <SelectOption key={project.id} value={project.id}>
                {project.name}
              </SelectOption>
            ))}
          </MultiCombobox>
        ) : null}
        <Select
          label="Expires"
          value={expiry}
          onChange={setExpiry}
          description={
            days === null
              ? 'A key that never expires is a key nobody remembers.'
              : `On ${dayWords(new Date(new Date(now).getTime() + days * DAY_MS).toISOString(), true)}.`
          }
        >
          {EXPIRY.map(([label]) => (
            <SelectOption key={label} value={label}>
              {label}
            </SelectOption>
          ))}
        </Select>
      </form>
    </Dialog>
  );
}

export function ShownKeyDialog({
  made,
  apiOrigin,
  projectNames,
  onClose,
}: {
  made: MadeKey;
  apiOrigin: string;
  projectNames: Readonly<Record<string, string>>;
  onClose: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  const example = `curl -H "Authorization: Bearer $DREFYN_API_KEY" ${apiOrigin}/v1/projects`;

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Copy your new key now"
      description="This is the only time it is shown. Put it in your secret manager before you close this."
      footer={(close) => (
        <div className="flex w-full flex-wrap items-center justify-between gap-8">
          <span className="text-caption text-secondary">
            Lost it later? Revoke it and make a new one.
          </span>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        <span id={labelId} className="font-medium text-ink">
          {made.name}
        </span>
        <div className="flex items-start gap-8 rounded-sm border border-rule-strong bg-sunken p-8">
          <code
            data-new-key=""
            aria-labelledby={labelId}
            className="min-w-0 flex-1 font-mono text-caption break-all text-ink"
          >
            {made.secret}
          </code>
          <Button
            size="sm"
            data-autofocus=""
            aria-label={copied ? 'Copied' : 'Copy the key'}
            onClick={() => {
              void navigator.clipboard.writeText(made.secret).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <dl className="flex flex-col gap-4">
        <div className="flex justify-between gap-12">
          <dt className="text-secondary">Can</dt>
          <dd>{scopeWords(made.scopes)}</dd>
        </div>
        <div className="flex justify-between gap-12">
          <dt className="text-secondary">Projects</dt>
          <dd>{projectWords(made.projectScope, made.projectIds, projectNames)}</dd>
        </div>
        <div className="flex justify-between gap-12">
          <dt className="text-secondary">Expires</dt>
          <dd>{made.expiresAt === null ? 'Never' : dayWords(made.expiresAt, true)}</dd>
        </div>
      </dl>
      <p>Send it as a header. Try it:</p>
      <code className="rounded-sm border border-rule bg-sunken p-8 font-mono text-caption break-all">
        {example}
      </code>
    </Dialog>
  );
}
