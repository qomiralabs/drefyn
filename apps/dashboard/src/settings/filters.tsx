'use client';
import { IconChevronDown, IconSearch, Menu, MenuItem } from '@drefyn/ui/react';
import type { ReactNode } from 'react';

export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
}

// A filter that shows its current value on the button, so the state of the list can be read
// without opening anything.
export function FilterMenu({
  label,
  value,
  mode,
  choices,
  selected,
  onChange,
}: {
  label: string;
  value: string;
  mode: 'single' | 'multiple';
  choices: readonly Choice[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}): ReactNode {
  return (
    <Menu
      size="sm"
      label={label}
      selectionMode={mode}
      selected={selected}
      onSelectionChange={onChange}
      trigger={
        <span className="inline-flex items-center gap-4">
          <span className="font-regular text-secondary">{label}</span> {value}
          <span className="inline-flex text-secondary">
            <IconChevronDown />
          </span>
        </span>
      }
    >
      {choices.map((choice) => (
        <MenuItem
          key={choice.id}
          id={choice.id}
          {...(choice.meta === undefined ? {} : { meta: choice.meta })}
        >
          {choice.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="relative flex h-control-md w-full items-center sm:w-shell-nav">
      <span className="pointer-events-none absolute start-8 inline-flex text-secondary">
        <IconSearch />
      </span>
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-full w-full min-w-0 rounded-sm border border-control bg-ground ps-32 pe-8 text-body-s text-ink placeholder:text-secondary focus-visible:focus-ring"
      />
    </label>
  );
}

export function FilterBar({
  label,
  count,
  children,
}: {
  label: string;
  count: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-8">
      {children}
      <span data-numeric="" className="ms-auto text-caption text-secondary" role="status">
        {count}
      </span>
    </div>
  );
}
