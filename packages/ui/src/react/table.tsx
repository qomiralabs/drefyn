'use client';
import { useState, type ReactNode } from 'react';
import {
  Cell,
  CheckboxButton,
  CheckboxField,
  Column,
  Row,
  Table as AriaTable,
  TableBody,
  TableHeader,
  type Key,
  type Selection,
  type SortDescriptor,
} from 'react-aria-components';
import { Button } from './button.tsx';
import { EmptyState } from './empty-state.tsx';
import { alertShape } from './icons/alert.tsx';
import { checkShape } from './icons/check.tsx';
import { chevronDownShape } from './icons/chevron-down.tsx';
import { Icon } from './icons/icon.tsx';
import { IconLock } from './icons/lock.tsx';
import { IconUpDown } from './icons/up-down.tsx';
import { Skeleton } from './skeleton.tsx';
import { sortRows, type SortDirection } from './table-sort.ts';

export interface TableColumn<T> {
  id: string;
  // The header word.
  label: string;
  cell: (row: T) => ReactNode;
  // Turns on sorting by this column. Numbers sort by value, words as people read them.
  sortValue?: (row: T) => string | number;
  // Figures: end aligned in tabular numbers, so digits line up down the column.
  numeric?: boolean;
  // The cell that names the row, read first by screen readers. Usually the first column.
  rowHeader?: boolean;
}

export interface TableSort {
  column: string;
  direction: SortDirection;
}

export interface TableProps<T extends { id: string }> {
  // Names the table for screen readers, and the loading and error words.
  label: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  // What shows in the frame when there are no rows, usually an EmptyState.
  empty: ReactNode;
  // The sort the caller holds, or the one to start from. The table sorts the rows it gets.
  sort?: TableSort;
  defaultSort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  // Adds a checkbox per row and a select all box.
  selectable?: boolean;
  selected?: readonly string[];
  defaultSelected?: readonly string[];
  // The selected ids in the order the rows show.
  onSelectionChange?: (ids: string[]) => void;
  // Rows that can be read but not selected or opened, each with the reason shown in it.
  disabledRows?: Readonly<Record<string, string>>;
  // Enter or a press on a row.
  onRowAction?: (id: string) => void;
  density?: 'compact' | 'comfortable';
  // Rows are on their way: skeleton rows under the header, or the rows already shown, busy.
  loading?: boolean;
  // Why the last load failed. With no rows it replaces the table; with rows it sits above.
  error?: string;
  onRetry?: () => void;
}

const ROW_HEIGHT = { compact: 'h-row-compact', comfortable: 'h-row-comfortable' } as const;
const SKELETON_ROWS = 5;

// A hairline between rows. Hover takes the hover fill except on a selected row, which keeps
// its wash and the accent bar on its leading edge; the ring sits inside the row's edge.
const ROW =
  'border-t border-rule text-body-s text-body outline-none transition-colors duration-fast ease-enter data-focus-visible:focus-ring-inset not-data-selected:data-hovered:bg-hover data-pressed:bg-pressed data-selected:bg-accent-wash';
const CELL = 'px-12 align-middle outline-none data-focus-visible:focus-ring-inset';
const HEAD =
  'h-row-compact px-12 text-start align-middle text-label font-medium text-secondary uppercase outline-none data-focus-visible:focus-ring-inset';

function SortMark({ direction }: { direction: SortDirection | undefined }): ReactNode {
  if (direction === undefined) return <IconUpDown />;
  return (
    <span className={`inline-flex text-ink ${direction === 'ascending' ? 'rotate-180' : ''}`}>
      <Icon name="chevron-down">{chevronDownShape}</Icon>
    </span>
  );
}

// React Aria disables a disabled row's box natively. aria-disabled is written too, so the
// box reads and paints the way every other unavailable control does.
const markUnavailable = (input: HTMLInputElement | null): void => {
  if (input === null) return;
  if (input.disabled) input.setAttribute('aria-disabled', 'true');
  else input.removeAttribute('aria-disabled');
};

// The checkbox React Aria wires into a row or the header, drawn like Checkbox.
function SelectionBox({ label }: { label?: string }): ReactNode {
  return (
    <CheckboxField
      slot="selection"
      inputRef={markUnavailable}
      {...(label === undefined ? {} : { 'aria-label': label })}
      className="inline-flex align-middle"
    >
      <CheckboxButton
        className={({ isDisabled }) =>
          `group inline-flex [&_input]:outline-none ${isDisabled ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-accent-on'}`
        }
      >
        {({ isSelected, isIndeterminate, isDisabled }) => (
          <span
            data-box=""
            className={`inline-flex size-icon-sm items-center justify-center rounded-xs border transition-colors duration-fast ease-enter group-data-focus-visible:focus-ring ${
              isDisabled
                ? 'border-disabled-edge bg-disabled-fill'
                : isSelected || isIndeterminate
                  ? 'border-accent-ink bg-accent-ink'
                  : 'border-control bg-ground'
            }`}
          >
            {isIndeterminate || isSelected ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="butt"
                strokeLinejoin="miter"
                focusable="false"
                aria-hidden="true"
                data-icon={isIndeterminate ? 'bar' : 'check'}
                className="size-12"
              >
                {isIndeterminate ? <path d="M6 12H18" /> : checkShape}
              </svg>
            ) : null}
          </span>
        )}
      </CheckboxButton>
    </CheckboxField>
  );
}

// The rows of a first load, under the header that is already there.
function LoadingRows({ label, density }: { label: string; density: 'compact' | 'comfortable' }) {
  return (
    <div data-skeleton="" className="flex flex-col">
      <span className="sr-only">Loading {label.toLowerCase()}</span>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <span
          key={i}
          className={`flex items-center border-t border-rule px-12 ${ROW_HEIGHT[density]}`}
        >
          <Skeleton width={i % 2 === 0 ? '3/4' : '1/2'} />
        </span>
      ))}
    </div>
  );
}

const markBusy =
  (busy: boolean) =>
  (el: HTMLElement | null): void => {
    if (el === null) return;
    if (busy) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
  };

// A React Aria grid on a native table: one Tab stop, the arrows move by row and into cells
// and headers, Home and End jump, Enter opens a row or sorts by a header, Space selects. The
// table sorts and selects itself unless the caller holds either. A disabled row stays
// reachable and readable with its reason; only its box and its action are unavailable. On a
// narrow screen the frame scrolls sideways so columns keep their width.
export function Table<T extends { id: string }>({
  label,
  columns,
  rows,
  empty,
  sort,
  defaultSort,
  onSortChange,
  selectable = false,
  selected,
  defaultSelected,
  onSelectionChange,
  disabledRows = {},
  onRowAction,
  density = 'compact',
  loading = false,
  error,
  onRetry,
}: TableProps<T>): ReactNode {
  if (label.trim() === '') throw new Error('A Table needs a label to name it.');
  const [ownSort, setOwnSort] = useState<TableSort | undefined>(defaultSort);
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(defaultSelected ?? []);
  const current = sort ?? ownSort;
  const chosen = selected ?? ownSelected;
  const failed = error !== undefined && error.trim() !== '';
  const retry =
    onRetry === undefined ? null : (
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    );

  if (!loading && rows.length === 0) {
    return (
      <div className="rounded-md border border-rule p-24">
        {failed ? (
          <EmptyState
            tone="error"
            title={`Could not load ${label.toLowerCase()}`}
            headingLevel={3}
            {...(retry === null ? {} : { action: retry })}
          >
            {error}
          </EmptyState>
        ) : (
          empty
        )}
      </div>
    );
  }

  const by = columns.find((c) => c.id === current?.column)?.sortValue;
  const shown =
    current === undefined || by === undefined ? rows : sortRows(rows, by, current.direction);
  const selectableIds = shown.filter((r) => disabledRows[r.id] === undefined).map((r) => r.id);
  const descriptor: SortDescriptor | undefined =
    current === undefined ? undefined : { column: current.column, direction: current.direction };

  const changeSort = (next: SortDescriptor) => {
    const picked: TableSort = { column: String(next.column), direction: next.direction };
    if (sort === undefined) setOwnSort(picked);
    onSortChange?.(picked);
  };
  const changeSelection = (keys: Selection) => {
    const wanted = keys === 'all' ? new Set<Key>(selectableIds) : keys;
    const ids = selectableIds.filter((id) => wanted.has(id));
    if (selected === undefined) setOwnSelected(ids);
    onSelectionChange?.(ids);
  };

  return (
    <div className="flex flex-col gap-8">
      {failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-8 text-body-s text-state-broken-text"
        >
          <Icon name="alert" tone="broken">
            {alertShape}
          </Icon>
          <span>{error}</span>
          {retry}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-rule">
        <AriaTable
          ref={markBusy(loading)}
          aria-label={label}
          selectionMode={selectable ? 'multiple' : 'none'}
          selectionBehavior="toggle"
          selectedKeys={new Set(chosen)}
          onSelectionChange={changeSelection}
          disabledKeys={Object.keys(disabledRows)}
          disabledBehavior="selection"
          {...(descriptor === undefined ? {} : { sortDescriptor: descriptor })}
          onSortChange={changeSort}
          {...(onRowAction === undefined
            ? {}
            : {
                onRowAction: (key: Key) => {
                  const id = String(key);
                  if (disabledRows[id] === undefined) onRowAction(id);
                },
              })}
          className="w-full border-collapse bg-ground outline-none"
        >
          <TableHeader className="bg-raised">
            {selectable ? (
              <Column id="__select" className={`${HEAD} w-0`}>
                <SelectionBox label="Select all" />
              </Column>
            ) : null}
            {columns.map((column) => (
              <Column
                key={column.id}
                id={column.id}
                isRowHeader={column.rowHeader === true}
                allowsSorting={column.sortValue !== undefined}
                className={`${HEAD} ${column.numeric === true ? 'text-end' : ''} ${
                  column.sortValue === undefined ? '' : 'cursor-pointer data-hovered:text-ink'
                }`}
              >
                {({ allowsSorting, sortDirection }) => (
                  <span
                    className={`inline-flex items-center gap-4 ${column.numeric === true ? 'flex-row-reverse' : ''}`}
                  >
                    {column.label}
                    {allowsSorting ? <SortMark direction={sortDirection} /> : null}
                  </span>
                )}
              </Column>
            ))}
          </TableHeader>
          <TableBody
            {...(loading && shown.length === 0
              ? {
                  renderEmptyState: () => <LoadingRows label={label} density={density} />,
                }
              : {})}
          >
            {shown.map((row) => {
              const reason = disabledRows[row.id];
              return (
                <Row
                  key={row.id}
                  id={row.id}
                  className={`${ROW} ${ROW_HEIGHT[density]} ${
                    onRowAction === undefined || reason !== undefined ? '' : 'cursor-pointer'
                  }`}
                >
                  {selectable ? (
                    // The selected row's accent bar sits on the leading edge of this cell.
                    <Cell
                      className={`${CELL} w-0 border-s-indicator border-s-transparent in-data-selected:border-s-accent-ink`}
                    >
                      <SelectionBox />
                    </Cell>
                  ) : null}
                  {columns.map((column) => (
                    <Cell
                      key={column.id}
                      className={`${CELL} ${column.numeric === true ? 'text-end tabular-nums' : ''}`}
                    >
                      {column.rowHeader === true && reason !== undefined ? (
                        <span className="flex flex-col py-4">
                          <span>{column.cell(row)}</span>
                          <span className="flex items-center gap-4 text-caption text-secondary">
                            <IconLock />
                            {reason}
                          </span>
                        </span>
                      ) : (
                        column.cell(row)
                      )}
                    </Cell>
                  ))}
                </Row>
              );
            })}
          </TableBody>
        </AriaTable>
      </div>
      {selectable ? (
        <p role="status" className="sr-only">
          {chosen.length === 0 ? '' : `${String(chosen.length)} selected`}
        </p>
      ) : null}
    </div>
  );
}
