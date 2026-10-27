import { describe, expect, it } from 'vitest';
import {
  allowed,
  CommandError,
  defineCommands,
  searchText,
  type Command,
} from '../src/shell/commands.ts';

const entry: Command = {
  id: 'docs',
  name: 'Docs',
  kind: 'product',
  keywords: ['Pages', 'API'],
  href: '/acme/docs',
  permission: 'docs.read',
};

const problem = (command: Command) => {
  try {
    defineCommands([command]);
  } catch (error) {
    return error instanceof CommandError ? error.problem : 'other';
  }
  return 'none';
};

describe('the command registry', () => {
  it('accepts a complete entry and freezes the list', () => {
    const list = defineCommands([entry]);
    expect(list).toEqual([entry]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it.each([
    ['name_missing', { ...entry, name: ' ' }],
    ['target_missing', { ...entry, href: '' }],
    ['permission_missing', { ...entry, permission: '' }],
    ['undo_and_confirm', { ...entry, undoable: true, confirm: 'typed' as const }],
  ])('refuses %s', (expected, command) => {
    expect(problem(command)).toBe(expected);
  });

  it('allows a typed confirm on work that cannot be undone', () => {
    expect(problem({ ...entry, confirm: 'typed' })).toBe('none');
    expect(problem({ ...entry, undoable: true })).toBe('none');
  });

  it('names the entry in its error', () => {
    expect(() => defineCommands([{ ...entry, name: '' }])).toThrow('Command docs: name_missing');
  });

  it('offers only entries the person may use', () => {
    const other = { ...entry, id: 'billing', permission: 'org.billing' };
    expect(allowed([entry, other], (p) => p === 'docs.read').map((c) => c.id)).toEqual(['docs']);
  });

  it('searches the name, the kind and the keywords in lower case', () => {
    expect(searchText(entry)).toBe('docs product pages api');
    expect(searchText({ ...entry, keywords: undefined as never })).toBe('docs product');
  });
});
