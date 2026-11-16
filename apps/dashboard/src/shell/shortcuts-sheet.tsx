'use client';
import { Dialog, Switch } from '@drefyn/ui/react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { KEYCAP } from './command-frame.tsx';
import { SHORTCUTS, SINGLE_KEYS_STORAGE, sheetGroups, singleKeysOn } from './shortcuts.ts';

function storedSingleKeys(): boolean {
  return singleKeysOn(() => localStorage.getItem(SINGLE_KEYS_STORAGE));
}

function storeSingleKeys(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SINGLE_KEYS_STORAGE);
    else localStorage.setItem(SINGLE_KEYS_STORAGE, 'off');
  } catch {
    // A browser that refuses storage keeps the keys on; the switch still answers this visit.
  }
}

export interface ShortcutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Every key the shell answers to, read from the registry, and the switch that turns single
// keys off for people whose screen reader or voice control they get in the way of.
export function ShortcutsSheet({ open, onOpenChange }: ShortcutsSheetProps): ReactNode {
  const [apple, setApple] = useState(false);
  const [single, setSingle] = useState(true);
  useEffect(() => {
    if (!open) return;
    setApple(/mac|iphone|ipad/i.test(navigator.userAgent));
    setSingle(storedSingleKeys());
  }, [open]);
  const groups = sheetGroups(SHORTCUTS, apple);
  return (
    <Dialog title="Keyboard shortcuts" open={open} onOpenChange={onOpenChange}>
      <Switch
        checked={single}
        onChange={(on) => {
          setSingle(on);
          storeSingleKeys(on);
        }}
        description="G then a key, and the question mark. They never fire while you type in a field."
      >
        Single key shortcuts
      </Switch>
      {groups.map((group) => (
        <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
          <h3
            id={`shortcuts-${group.title}`}
            className="border-b border-rule pb-4 text-label text-secondary uppercase"
          >
            {group.title}
          </h3>
          <ul data-shortcuts={group.title}>
            {group.rows.map((row) => (
              <li
                key={row.id}
                data-shortcut={row.id}
                className="flex min-h-row-compact items-center justify-between gap-16 border-b border-rule py-4 last:border-b-0"
              >
                <span className="text-body">
                  {row.does}
                  <span className="sr-only">, {row.spoken}</span>
                </span>
                <span aria-hidden="true" className="flex shrink-0 items-center gap-4">
                  {row.keys.map((chord, i) => (
                    <Fragment key={i}>
                      {i === 0 ? null : <span className="text-caption text-secondary">then</span>}
                      {chord.map((key) => (
                        <kbd key={key} className={KEYCAP}>
                          {key}
                        </kbd>
                      ))}
                    </Fragment>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
