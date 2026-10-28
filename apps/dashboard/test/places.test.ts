import { describe, expect, it } from 'vitest';
import { commandFilter, type Command } from '../src/shell/commands.ts';
import { places } from '../src/shell/places.ts';

const entries = places('acme');
const filter = commandFilter(entries);
// What the bar shows for a query: the ids its filter keeps, in registry order.
const found = (query: string) =>
  entries.filter((e) => filter(`${e.name}, ${e.kind}`, query, { key: e.id })).map((e) => e.name);

describe('command bar search', () => {
  it('finds entries by their keywords, not only their names', () => {
    expect(found('billing')).toEqual(['Plan and usage']);
    expect(found('seats')).toEqual(['Members']);
    expect(found('invite')).toEqual(['Members']);
  });

  it('matches names and kinds whatever the case', () => {
    expect(found('PAYMENTS')).toContain('Payments API docs');
    expect(found('status page')).toEqual(['Acme status']);
  });

  it('shows everything for an empty query', () => {
    expect(found('')).toHaveLength(entries.length);
    expect(found('   ')).toHaveLength(entries.length);
  });

  it('falls back to the row text for a node it does not know', () => {
    const only = commandFilter([]);
    expect(only('Plan and usage, organization', 'plan', { key: 'missing' })).toBe(true);
    expect(only('Plan and usage, organization', 'billing', { key: 'missing' })).toBe(false);
  });

  it('every entry in the registry is reachable by searching its own name', () => {
    for (const entry of entries) expect(found(entry.name), entry.id).toContain(entry.name);
  });

  it('keeps every place inside the organization', () => {
    for (const entry of entries as readonly Command[]) expect(entry.href).toMatch(/^\/acme(\/|$)/);
  });
});
