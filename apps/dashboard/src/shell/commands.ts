import type { Permission } from '@drefyn/auth/permissions';
import type { SectionIcon } from './sections.ts';

// The command registry: places and actions the command bar can reach, as data. Products add
// their own entries; the code that runs an action loads with the action, never with the shell.
export interface Command {
  readonly id: string;
  // What the row says. Actions read as verbs, places as their names.
  readonly name: string;
  // The kind of thing, said in the row while results are flat ("Docs project").
  readonly kind: string;
  // Drawn at the start of the row, so kinds tell apart at a glance.
  readonly icon: CommandIcon;
  // For objects: their state now, as a word beside its mark.
  readonly state?: {
    readonly state: 'fresh' | 'stale' | 'broken' | 'neutral';
    readonly word: string;
  };
  readonly keywords?: readonly string[];
  // Where it goes. Every entry needs a target the keyboard can reach.
  readonly href: string;
  // The permission the person needs, checked before the entry is offered.
  readonly permission: Permission;
  readonly shortcut?: string;
  // Undoable work never asks for a typed confirmation: Undo is the safety net.
  readonly undoable?: boolean;
  readonly confirm?: 'typed';
}

export type CommandProblem =
  'name_missing' | 'target_missing' | 'permission_missing' | 'undo_and_confirm';

export type CommandIcon = SectionIcon | 'schema';

export class CommandError extends Error {
  readonly problem: CommandProblem;
  readonly id: string;

  constructor(problem: CommandProblem, id: string) {
    super(`Command ${id}: ${problem}`);
    this.name = 'CommandError';
    this.problem = problem;
    this.id = id;
  }
}

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

// Refuses an entry the bar could not show or run safely, at registration, not at use.
export function defineCommands(entries: readonly Command[]): readonly Command[] {
  for (const entry of entries) {
    if (blank(entry.name)) throw new CommandError('name_missing', entry.id);
    if (blank(entry.href)) throw new CommandError('target_missing', entry.id);
    if (blank(entry.permission)) throw new CommandError('permission_missing', entry.id);
    if (entry.undoable === true && entry.confirm === 'typed') {
      throw new CommandError('undo_and_confirm', entry.id);
    }
  }
  return Object.freeze([...entries]);
}

// The entries a person may see: the ones whose permission they hold.
export function allowed(
  entries: readonly Command[],
  can: (permission: Permission) => boolean,
): readonly Command[] {
  return entries.filter((entry) => can(entry.permission));
}

const MARKS = /\p{M}/gu;
const SPACES = /\s+/gu;

// Reduces text to what a person means by it, so a query finds a name however either was typed:
// accents as one code point or two, or left out, any case, any run of spaces. Upper first
// because lower alone leaves pairs apart (ß and SS, ı and I). Final sigma becomes plain sigma,
// or a query cut at that letter would miss the rest of the word.
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(MARKS, '')
    .toUpperCase()
    .toLowerCase()
    .replace(MARKS, '')
    .replaceAll('\u03c2', '\u03c3')
    .replace(SPACES, ' ')
    .trim();
}

// The text a query matches against, folded once rather than on every key.
export function searchText(entry: Command): string {
  return fold([entry.name, entry.kind, ...(entry.keywords ?? [])].join(' '));
}

// The filter the command bar's autocomplete runs: the query against each entry's search text,
// so keywords count as well as the row's words. A node it does not know falls back to the row
// text. An empty query keeps everything.
export function commandFilter(
  entries: readonly Command[],
): (text: string, input: string, node: { key: unknown }) => boolean {
  const index = new Map(entries.map((entry) => [entry.id, searchText(entry)]));
  return (text, input, node) => {
    const query = fold(input);
    if (query === '') return true;
    const haystack = index.get(String(node.key)) ?? fold(text);
    return haystack.includes(query);
  };
}
