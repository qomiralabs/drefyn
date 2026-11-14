// Every key the shell answers to, as data. The frame's handler and the shortcuts sheet both
// read this list, so the sheet cannot leave out a key that works or list one that does not.

// One press: the keys held together. "Mod" is Command on Apple devices and Ctrl elsewhere.
export type Chord = readonly string[];

export interface Shortcut {
  readonly id: string;
  // Presses in order: G then 1 is two presses of one key each.
  readonly keys: readonly Chord[];
  // What it does, as the sheet says it.
  readonly does: string;
  // Single character shortcuts can be turned off, as WCAG 2.1.4 asks; they never fire in a
  // field, with a modifier held, or over an open overlay.
  readonly single: boolean;
  // For a G sequence: the place it opens, an organization path or "overview".
  readonly target?: string;
}

export const SHORTCUTS: readonly Shortcut[] = Object.freeze([
  {
    id: 'command-bar',
    keys: [['Mod', 'K']],
    does: 'Open or close the command bar, from anywhere, fields included',
    single: false,
  },
  { id: 'go-docs', keys: [['G'], ['1']], does: 'Go to Docs', single: true, target: 'docs' },
  { id: 'go-studio', keys: [['G'], ['2']], does: 'Go to Studio', single: true, target: 'studio' },
  { id: 'go-status', keys: [['G'], ['3']], does: 'Go to Status', single: true, target: 'status' },
  {
    id: 'go-overview',
    keys: [['G'], ['O']],
    does: 'Go to the organization overview',
    single: true,
    target: 'overview',
  },
  { id: 'shortcuts', keys: [['?']], does: 'Show these shortcuts', single: true },
  {
    id: 'next-area',
    keys: [['F6']],
    does: 'Move to the next area: top bar, sidebar, page, notifications',
    single: false,
  },
  {
    id: 'previous-area',
    keys: [['Shift', 'F6']],
    does: 'Move to the previous area',
    single: false,
  },
  {
    id: 'close',
    keys: [['Esc']],
    does: 'Close what is open and go back to where you were',
    single: false,
  },
]);

// The second key of each G sequence and where it goes, for the frame's handler.
export function sequences(list: readonly Shortcut[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of list) {
    const second = s.keys[1]?.[0];
    if (s.target === undefined || s.keys[0]?.[0] !== 'G' || second === undefined) continue;
    out[second.toLowerCase()] = s.target;
  }
  return out;
}

// How a key is drawn on a keycap. Apple devices show the Command sign; everything else Ctrl.
export function keyLabel(key: string, apple: boolean): string {
  if (key === 'Mod') return apple ? '⌘' : 'Ctrl';
  return key;
}

// How a key is read: the keycaps are hidden from assistive tech, so each row carries its keys
// in words as well.
export function spoken(keys: readonly Chord[], apple: boolean): string {
  const name = (key: string) => (key === 'Mod' ? (apple ? 'Command' : 'Control') : key);
  return keys.map((chord) => chord.map(name).join(' plus ')).join(' then ');
}

export interface SheetRow {
  readonly id: string;
  readonly does: string;
  readonly keys: readonly (readonly string[])[];
  readonly spoken: string;
}

export interface SheetGroup {
  readonly title: string;
  readonly rows: readonly SheetRow[];
}

// What the sheet lists: keys that work anywhere first, then the single keys the switch
// turns off, so a person sees which ones that switch affects.
export function sheetGroups(list: readonly Shortcut[], apple: boolean): readonly SheetGroup[] {
  const row = (s: Shortcut): SheetRow => ({
    id: s.id,
    does: s.does,
    keys: s.keys.map((chord) => chord.map((key) => keyLabel(key, apple))),
    spoken: spoken(s.keys, apple),
  });
  return [
    { title: 'Anywhere', rows: list.filter((s) => !s.single).map(row) },
    { title: 'Single keys', rows: list.filter((s) => s.single).map(row) },
  ];
}

// Single keys stay on unless the person turns them off; the choice lives in this browser.
export const SINGLE_KEYS_STORAGE = 'dr-single-keys';

export function singleKeysOn(read: () => string | null): boolean {
  try {
    return read() !== 'off';
  } catch {
    // Storage that refuses to answer must not take the shortcuts away.
    return true;
  }
}
