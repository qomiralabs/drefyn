import { PERMISSIONS, permissionsFor } from '@drefyn/auth/permissions';
import type { Product } from '@drefyn/entitlements';
import { describe, expect, it } from 'vitest';
import {
  allowed,
  CommandError,
  defineCommands,
  searchText,
  type Command,
} from '../src/shell/commands.ts';
import { places, visiblePlaces } from '../src/shell/places.ts';

const entry: Command = {
  id: 'docs',
  name: 'Docs',
  kind: 'product',
  icon: 'page',
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
    const other = { ...entry, id: 'billing', permission: 'org.manage_billing' as const };
    expect(allowed([entry, other], (p) => p === 'docs.read').map((c) => c.id)).toEqual(['docs']);
  });

  it('searches the name, the kind and the keywords in lower case', () => {
    expect(searchText(entry)).toBe('docs product pages api');
    expect(searchText({ ...entry, keywords: undefined as never })).toBe('docs product');
  });

  it('keeps every place behind a permission that exists', () => {
    for (const place of places('acme')) {
      expect((PERMISSIONS as readonly string[]).includes(place.permission), place.id).toBe(true);
    }
  });

  it('shows a member fewer places than an admin, and an admin no fewer than an owner', () => {
    const reach = new Set<Product>(['docs', 'studio', 'status']);
    const visible = (permissions: readonly string[]) =>
      visiblePlaces('acme', permissions).map((p) => p.id);
    const member = visible(permissionsFor('member', new Set()));
    const admin = visible(permissionsFor('admin', reach));
    expect(member).toEqual(['overview', 'plan', 'members', 'settings']);
    expect(admin.length).toBeGreaterThan(member.length);
    expect(visible(permissionsFor('owner', reach))).toEqual(admin);
  });

  it('shows nothing with no permissions', () => {
    expect(visiblePlaces('acme', [])).toEqual([]);
  });
});
