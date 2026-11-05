import { describe, expect, it } from 'vitest';
import { startIncidentCommand } from '../src/incident/feed.ts';
import { commandFilter } from '../src/shell/commands.ts';
import { places, visiblePlaces } from '../src/shell/places.ts';

const PROJECTS = {
  'docs/payments-api': { name: 'Payments API docs', product: 'docs' },
  'status/acme-status': { name: 'Acme status', product: 'status' },
  'studio/launch': { name: 'Launch', product: 'studio' },
} as const;

const entries = places('acme', PROJECTS);
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

  it("keeps every place inside the organization or the person's own account", () => {
    for (const entry of entries) expect(entry.href).toMatch(/^\/(acme|account)(\/|$)/);
  });
});

describe('actions from outside the list', () => {
  const start = startIncidentCommand('acme');

  it('are not in the list by themselves', () => {
    expect(entries.map((e) => e.id)).not.toContain(start.id);
  });

  it('show only to someone with their permission, and the bar can find them', () => {
    const ids = (held: string[]) => visiblePlaces('acme', held, PROJECTS, [start]).map((e) => e.id);
    expect(ids(['org.read'])).not.toContain(start.id);
    expect(ids(['status.read'])).toContain(start.id);
    expect(start.href).toBe('/acme/status/acme-status/incidents/new');
    expect(start.keywords).toContain('outage');
  });
});
