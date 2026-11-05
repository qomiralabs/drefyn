'use client';
import { Badge, Button, EmptyState, Skeleton, Table } from '@drefyn/ui/react';
import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DocsPage, Freshness } from '../fixtures/pages.ts';
import { useOptimistic, type Tenant } from '../optimistic/use-optimistic.tsx';
import { writePages } from '../server/pages-actions.ts';
import { pagesFrom } from './client.ts';

const FRESHNESS: Readonly<Record<Freshness, string>> = {
  fresh: 'Fresh',
  stale: 'Out of date',
  neutral: 'Not checked',
};

const COLUMNS: Parameters<typeof Table<DocsPage>>[0]['columns'] = [
  { id: 'title', label: 'Page', rowHeader: true, cell: (page) => page.title },
  { id: 'section', label: 'Section', cell: (page) => page.section },
  {
    id: 'freshness',
    label: 'Freshness',
    cell: (page) => (
      <Badge state={page.freshness} onFill>
        {FRESHNESS[page.freshness]}
      </Badge>
    ),
  },
  {
    id: 'edited',
    label: 'Edited',
    cell: (page) => <time dateTime={page.editedOn}>{page.edited}</time>,
  },
  {
    id: 'readers',
    label: 'Readers, 7 d',
    numeric: true,
    cell: (page) => page.readers.toLocaleString('en-US'),
  },
];

const count = (total: number) => (total === 1 ? '1 page' : `${String(total)} pages`);

const never = () => () => undefined;

// React Aria's grid writes style attributes into its rows and hidden inputs, and the CSP drops
// those from server HTML, which would leave the inputs showing. So the server sends this, row
// for row the same height, and the grid mounts in its place before anyone can act.
function RowsArriving({ rows }: { rows: number }): ReactNode {
  return (
    <div data-skeleton="" className="flex flex-col overflow-hidden rounded-md border border-rule">
      <span className="sr-only">Loading pages</span>
      <span className="h-row-compact bg-raised" />
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="flex h-row-compact items-center border-t border-rule px-12">
          <Skeleton width={i % 2 === 0 ? '3/4' : '1/2'} />
        </span>
      ))}
    </div>
  );
}

// The first working view on placeholder data. Archive stays on screen with no selection, so
// the button under a keyboard user's focus does not vanish the moment they press it.
export function PagesTable({
  org,
  project,
  pages,
  tenant,
}: {
  org: string;
  project: string;
  pages: readonly DocsPage[];
  tenant: Tenant;
}): ReactNode {
  const [all, store] = useOptimistic(pages, tenant);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const summary = useId();
  const inBrowser = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const rows = useMemo(() => all.filter((page) => !page.archived), [all]);
  const chosen = useMemo(() => {
    const held = new Set(selected);
    return rows.filter((page) => held.has(page.id));
  }, [rows, selected]);

  const write = async (changes: readonly { id: string; archived: boolean }[]) =>
    pagesFrom(await writePages(org, { project, pages: changes }));

  const archive = () => {
    const name = chosen.length === 1 ? chosen[0]?.title : undefined;
    const ids = chosen.map((page) => page.id);
    setSelected([]);
    store.run({
      action: 'pages.archive',
      ids,
      apply: (page) => ({ ...page, archived: true }),
      send: () => write(ids.map((id) => ({ id, archived: true }))),
      revert: (before) => write(before.map(({ id, archived }) => ({ id, archived }))),
      done: `Archived ${name ?? count(ids.length)}.`,
      undone: name === undefined ? `${count(ids.length)} are back.` : `${name} is back.`,
      failed: `Could not archive ${name ?? count(ids.length)}.`,
      // Keeps the choice, so trying again is one press.
      onRollback: () => {
        setSelected((now) => [...new Set([...now, ...ids])]);
      },
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex h-row-compact items-center justify-between gap-12">
        <p id={summary} className="text-caption text-secondary tabular-nums">
          {chosen.length > 0
            ? `${String(chosen.length)} selected`
            : `${count(rows.length)}. Select some to archive.`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={chosen.length === 0}
          aria-describedby={summary}
          onClick={archive}
        >
          Archive
        </Button>
      </div>
      {inBrowser ? (
        <Table
          label="Pages"
          columns={COLUMNS}
          rows={rows}
          selectable
          selected={chosen.map((page) => page.id)}
          onSelectionChange={setSelected}
          empty={
            <EmptyState title="No pages to show" headingLevel={2}>
              Archived pages are kept. Nothing was deleted.
            </EmptyState>
          }
        />
      ) : (
        <RowsArriving rows={rows.length} />
      )}
    </div>
  );
}
