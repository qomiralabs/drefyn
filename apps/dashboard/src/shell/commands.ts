// The command registry: places and actions the command bar can reach, as data. Products add
// their own entries; the code that runs an action loads with the action, never with the shell.
export interface Command {
  readonly id: string;
  // What the row says. Actions read as verbs, places as their names.
  readonly name: string;
  // The kind of thing, said in the row while results are flat ("Docs project").
  readonly kind: string;
  readonly keywords?: readonly string[];
  // Where it goes. Every entry needs a target the keyboard can reach.
  readonly href: string;
  // The permission the person needs, checked before the entry is offered.
  readonly permission: string;
  readonly shortcut?: string;
  // Undoable work never asks for a typed confirmation: Undo is the safety net.
  readonly undoable?: boolean;
  readonly confirm?: 'typed';
}

export type CommandProblem =
  'name_missing' | 'target_missing' | 'permission_missing' | 'undo_and_confirm';

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
  can: (permission: string) => boolean,
): readonly Command[] {
  return entries.filter((entry) => can(entry.permission));
}

// The text a query matches against, lower cased once rather than on every key.
export function searchText(entry: Command): string {
  return [entry.name, entry.kind, ...(entry.keywords ?? [])].join(' ').toLowerCase();
}

// TODO(#59): filter through searchText.
export const commandFilter =
  (_entries: readonly Command[]) =>
  (_text: string, _input: string, _node: { key: unknown }): boolean =>
    false;
