'use client';
import { Badge, Button, Dialog, IconKey, IconPlus, TextField, toast } from '@drefyn/ui/react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { revokeKey } from '../server/settings-actions.ts';
import { FilterBar, FilterMenu, SearchBox } from './filters.tsx';
import {
  dayWords,
  firstPage,
  keyFilterSearch,
  keyRowTone,
  needsTypedName,
  plural,
  PRODUCT_LABELS,
  projectWords,
  scopeWords,
  usedWords,
  type KeyFilters,
  type LastUsed,
  type Product,
} from './models.ts';
import { Fine, PageHead, SettingsPage } from './parts.tsx';
import { useSettings, wasCancelled } from './provider.tsx';
import { problemWords, type MadeKey } from './results.ts';

const CreateKeyDialog = dynamic(() => import('./create-key.tsx').then((m) => m.CreateKeyDialog), {
  ssr: false,
});
const ShownKeyDialog = dynamic(() => import('./create-key.tsx').then((m) => m.ShownKeyDialog), {
  ssr: false,
});

const SEARCH_WAIT_MS = 250;

export interface KeyRow {
  readonly id: string;
  readonly name: string;
  readonly suffix: string;
  readonly scopes: readonly string[];
  readonly projectScope: 'all' | 'listed';
  readonly projectIds: readonly string[];
  readonly state: 'live' | 'expired' | 'revoked';
  readonly creatorName: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

export interface KeysFacts {
  readonly org: string;
  readonly organization: string;
  readonly manage: boolean;
  readonly apiOrigin: string;
  readonly now: string;
  readonly keys: readonly KeyRow[];
  readonly matched: number;
  readonly total: number;
  readonly live: number;
  readonly nextCursor: string | null;
  readonly creators: readonly {
    readonly membershipId: string;
    readonly name: string;
    readonly keys: number;
  }[];
  readonly formerKeys: number;
  readonly products: Readonly<Record<Product, number>>;
  readonly filters: KeyFilters;
  readonly projectNames: Readonly<Record<string, string>>;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly grantable: readonly string[];
}

const LAST_USED_WORDS: Readonly<Record<LastUsed, string>> = {
  any: 'Any time',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  never: 'Never used',
};

function RevokeDialog({
  org,
  row,
  now,
  onClose,
  onRevoked,
}: {
  org: string;
  row: KeyRow;
  now: string;
  onClose: () => void;
  onRevoked: () => void;
}): ReactNode {
  const { act } = useSettings();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const typing = needsTypedName(row.lastUsedAt, now);
  const ready = !typing || typed === row.name;

  async function confirm() {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    const done = await act('Revoking an API key', () => revokeKey(org, row.id));
    setBusy(false);
    if (done.ok) onRevoked();
    else if (!wasCancelled(done)) setError(problemWords(done.problem));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Revoke ${row.name}?`}
      description="Requests with this key fail from now on. This cannot be undone."
      busy={busy}
      {...(error === undefined ? {} : { error })}
      footer={(close) => (
        <>
          <Button data-autofocus={typing ? undefined : ''} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            busyLabel="Revoking"
            disabled={!ready}
            onClick={() => void confirm()}
          >
            Revoke key
          </Button>
        </>
      )}
    >
      <dl className="flex flex-col gap-4">
        <div className="flex justify-between gap-12">
          <dt className="text-secondary">Key</dt>
          <dd className="font-mono text-caption">drf_ak_...{row.suffix}</dd>
        </div>
        <div className="flex justify-between gap-12">
          <dt className="text-secondary">Last used</dt>
          <dd>{usedWords(row.lastUsedAt, now)}</dd>
        </div>
      </dl>
      {typing ? (
        <>
          <p>
            It was used recently, so something still depends on it. If that job still needs access,
            create its new key first.
          </p>
          <TextField
            id="revoke-name"
            label={`Type ${row.name} to revoke it`}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={setTyped}
          />
        </>
      ) : null}
    </Dialog>
  );
}

function StateWord({ row }: { row: KeyRow }): ReactNode {
  if (row.state === 'revoked') return <Badge state="neutral">Revoked</Badge>;
  if (row.state === 'expired') return <Badge state="neutral">Expired</Badge>;
  return row.expiresAt === null ? 'No expiry' : dayWords(row.expiresAt, true);
}

export function KeysScreen({
  facts,
  overlay = null,
  shownKey = null,
}: {
  facts: KeysFacts;
  overlay?: 'create' | { readonly revoke: string } | null;
  shownKey?: MadeKey | null;
}): ReactNode {
  const { org, organization, manage, filters, now } = facts;
  const { refresh } = useSettings();
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(overlay === 'create');
  const [revoking, setRevoking] = useState<string | null>(
    overlay !== null && overlay !== 'create' ? overlay.revoke : null,
  );
  const [gone, setGone] = useState<readonly string[]>([]);
  const [made, setMade] = useState<MadeKey | null>(shownKey);
  const [search, setSearch] = useState(filters.search ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A key revoked here reads as revoked at once; the refresh brings the same from the server.
  const rows = facts.keys.map((row) =>
    gone.includes(row.id) ? { ...row, state: 'revoked' as const } : row,
  );
  const target = rows.find((row) => row.id === revoking);

  function go(next: Partial<KeyFilters>) {
    router.replace(`${pathname}${keyFilterSearch({ ...firstPage(filters), ...next })}`, {
      scroll: false,
    });
  }

  function typeSearch(value: string) {
    setSearch(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const { products, createdBy, lastUsed } = filters;
      const typed = value.trim();
      const next = { products, createdBy, lastUsed, ...(typed === '' ? {} : { search: typed }) };
      router.replace(`${pathname}${keyFilterSearch(next)}`, { scroll: false });
    }, SEARCH_WAIT_MS);
  }

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const creatorWords =
    filters.createdBy.length === 0
      ? 'Anyone'
      : filters.createdBy.length === 1
        ? filters.createdBy[0] === 'former'
          ? 'Former'
          : (facts.creators.find((c) => c.membershipId === filters.createdBy[0])?.name ??
            '1 person')
        : `${String(filters.createdBy.length)} people`;
  const productWords =
    filters.products.length === 0
      ? 'Anything'
      : filters.products.map((p) => PRODUCT_LABELS[p]).join(', ');
  const filtered =
    (filters.search ?? '') !== '' ||
    filters.products.length > 0 ||
    filters.createdBy.length > 0 ||
    filters.lastUsed !== 'any';

  const createButton = (
    <Button
      variant="primary"
      icon={<IconPlus />}
      onClick={() => {
        setCreating(true);
      }}
    >
      Create key
    </Button>
  );

  const dialogs = (
    <>
      {creating ? (
        <CreateKeyDialog
          org={org}
          organization={organization}
          projects={facts.projects}
          grantable={facts.grantable}
          now={now}
          onClose={() => {
            setCreating(false);
          }}
          onMade={(key) => {
            setCreating(false);
            setMade(key);
            refresh();
          }}
        />
      ) : null}
      {made === null ? null : (
        <ShownKeyDialog
          made={made}
          apiOrigin={facts.apiOrigin}
          projectNames={facts.projectNames}
          onClose={() => {
            setMade(null);
          }}
        />
      )}
      {target === undefined ? null : (
        <RevokeDialog
          org={org}
          row={target}
          now={now}
          onClose={() => {
            setRevoking(null);
          }}
          onRevoked={() => {
            setRevoking(null);
            setGone((ids) => [...ids, target.id]);
            toast({ title: `${target.name} is revoked.`, description: 'This cannot be undone.' });
            refresh();
          }}
        />
      )}
    </>
  );

  if (facts.total === 0) {
    return (
      <SettingsPage width="calm">
        <div className="flex max-w-measure flex-col gap-8">
          <p className="text-label text-secondary uppercase">{organization}</p>
          <span className="inline-flex text-secondary">
            <IconKey size="md" />
          </span>
          <h1 tabIndex={-1} className="text-title text-ink outline-none focus-visible:focus-ring">
            No API keys yet
          </h1>
          <p className="text-secondary">
            Keys let CI jobs and scripts call the Drefyn API for {organization}, limited to the
            projects and actions you choose. Each key is shown once, when you make it.
          </p>
          {manage ? (
            <div>{createButton}</div>
          ) : (
            <Fine>Only owners and admins can create or revoke keys.</Fine>
          )}
        </div>
        {dialogs}
      </SettingsPage>
    );
  }

  return (
    <SettingsPage width="work">
      <PageHead
        label={organization}
        claim={`${plural(facts.live, 'key')} can call the Drefyn API for ${organization}.`}
        rest="Each key is shown once, when it is made."
        {...(manage ? { actions: createButton } : {})}
      />
      {manage ? null : <Fine>Only owners and admins can create or revoke keys.</Fine>}
      <FilterBar
        label="Filter keys"
        count={
          filtered
            ? `${String(facts.matched)} of ${String(facts.total)} shown`
            : `${String(facts.matched)} shown`
        }
      >
        <SearchBox label="Search keys by name" value={search} onChange={typeSearch} />
        <FilterMenu
          label="Can"
          mode="multiple"
          value={productWords}
          selected={filters.products}
          choices={(Object.keys(PRODUCT_LABELS) as Product[]).map((product) => ({
            id: product,
            label: PRODUCT_LABELS[product],
            meta: String(facts.products[product]),
          }))}
          onChange={(ids) => {
            go({ products: ids as Product[] });
          }}
        />
        <FilterMenu
          label="Created by"
          mode="multiple"
          value={creatorWords}
          selected={filters.createdBy}
          choices={[
            ...facts.creators.map((creator) => ({
              id: creator.membershipId,
              label: creator.name,
              meta: String(creator.keys),
            })),
            ...(facts.formerKeys === 0
              ? []
              : [
                  {
                    id: 'former',
                    label: `People no longer in ${organization}`,
                    meta: String(facts.formerKeys),
                  },
                ]),
          ]}
          onChange={(ids) => {
            go({ createdBy: ids });
          }}
        />
        <FilterMenu
          label="Last used"
          mode="single"
          value={LAST_USED_WORDS[filters.lastUsed]}
          selected={[filters.lastUsed]}
          choices={(Object.keys(LAST_USED_WORDS) as LastUsed[]).map((id) => ({
            id,
            label: LAST_USED_WORDS[id],
          }))}
          onChange={(ids) => {
            const [lastUsed] = ids;
            if (lastUsed !== undefined) go({ lastUsed: lastUsed as LastUsed });
          }}
        />
        {filtered ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setSearch('');
              router.replace(pathname, { scroll: false });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </FilterBar>
      {rows.length === 0 ? (
        <div className="py-16">
          <p className="font-medium text-ink">No key matches these filters.</p>
          <Fine>Search looks at key names. Try fewer filters, or clear them.</Fine>
        </div>
      ) : (
        <div className="settings-frame">
          <table className="settings-table">
            <caption className="sr-only">API keys for {organization}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Can</th>
                <th scope="col">Projects</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                {manage ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={keyRowTone(row.state).row}>
                  <td>
                    <span className="flex flex-col">
                      <span className={`font-medium ${keyRowTone(row.state).name}`}>
                        {row.name}
                      </span>
                      <span className="font-mono text-caption text-secondary">
                        drf_ak_...{row.suffix}
                      </span>
                    </span>
                  </td>
                  <td data-label="Can">{scopeWords(row.scopes)}</td>
                  <td data-label="Projects">
                    {projectWords(row.projectScope, row.projectIds, facts.projectNames)}
                  </td>
                  <td data-wide="">
                    {row.creatorName ?? `Someone no longer in ${organization}`},{' '}
                    {dayWords(row.createdAt)}
                  </td>
                  <td data-label="Last used">{usedWords(row.lastUsedAt, now)}</td>
                  <td data-label="Expires">
                    <StateWord row={row} />
                  </td>
                  {manage ? (
                    <td className="sm:text-end">
                      {row.state === 'revoked' ? null : (
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Revoke ${row.name}`}
                          onClick={() => {
                            setRevoking(row.id);
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {facts.nextCursor === null ? null : (
            <div className="flex justify-end border-t border-rule px-12 py-8">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  router.push(
                    `${pathname}${keyFilterSearch({ ...filters, cursor: facts.nextCursor ?? '' })}`,
                  );
                }}
              >
                Next page
              </Button>
            </div>
          )}
        </div>
      )}
      <Fine>
        Keys belong to {organization}, not to a person, and never use a seat. Send them in an
        Authorization header; a key in a URL is refused, so it never lands in a log.
      </Fine>
      {dialogs}
    </SettingsPage>
  );
}
