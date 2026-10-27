import { describe, expect, it } from 'vitest';
import { PLACEHOLDER } from '../src/fixtures/placeholder.ts';
import { findProject, projectsOf } from '../src/fixtures/projects.ts';
import { NEEDS_YOU, PLACEHOLDER_SHELL, needsYouSentence } from '../src/fixtures/shell.ts';
import { ORG_SECTIONS, SECTIONS, sectionOf } from '../src/shell/sections.ts';

describe('what needs you', () => {
  it('is one list for the inbox and the overview, sized by the placeholder count', () => {
    expect(NEEDS_YOU).toHaveLength(PLACEHOLDER.inbox.needsYou);
    expect(PLACEHOLDER_SHELL.inbox).toBe(NEEDS_YOU);
  });

  it('says the count in words', () => {
    expect([0, 1, 2, 3].map(needsYouSentence)).toEqual([
      'Nothing needs you.',
      'One thing needs you.',
      'Two things need you.',
      'Three things need you.',
    ]);
    expect(needsYouSentence(12)).toBe('12 things need you.');
  });
});

describe('placeholder projects', () => {
  it('finds a project only under its own product', () => {
    expect(findProject('docs', 'payments-api')).toEqual({
      slug: 'payments-api',
      id: 'prj_payments',
      product: 'docs',
      name: 'Payments API docs',
    });
    expect(findProject('status', 'payments-api')).toBeUndefined();
    expect(findProject('docs', 'missing')).toBeUndefined();
  });

  it('lists the projects of each product', () => {
    expect(projectsOf('docs').map((p) => p.slug)).toEqual([
      'payments-api',
      'new-docs',
      'unreachable',
      'pending',
    ]);
    expect(projectsOf('status').map((p) => p.slug)).toEqual(['acme-status']);
    expect(projectsOf('studio')).toEqual([]);
  });

  it('gives the shell every project by name and product', () => {
    expect(PLACEHOLDER_SHELL.projects['acme-status']).toEqual({
      name: 'Acme status',
      product: 'status',
    });
  });
});

describe('sidebar sections', () => {
  it('start each product with its home and end Docs and Status with settings', () => {
    for (const product of ['docs', 'studio', 'status'] as const) {
      expect(SECTIONS[product][0]?.slug).toBe('');
    }
    expect(SECTIONS.docs.at(-1)?.label).toBe('Site settings');
    expect(SECTIONS.status.at(-1)?.label).toBe('Page settings');
  });

  it('finds a section by product and slug', () => {
    expect(sectionOf('docs', 'reference')?.label).toBe('API reference');
    expect(sectionOf('studio', 'pages')).toBeUndefined();
  });

  it('keep organization pages under /settings, which no product can shadow', () => {
    expect(ORG_SECTIONS.map((s) => s.slug)).toEqual([
      '',
      'settings/plan',
      'settings/members',
      'settings',
    ]);
  });
});
