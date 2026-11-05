import type { ReactElement } from 'react';
import { createElement } from 'react';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import type { PageInput, SitePageData } from '../src/index.ts';

export const tenant: TenantRef = {
  organizationId: organizationId('00000000-0000-4000-8000-000000000001'),
  projectId: projectId('00000000-0000-4000-8000-000000000002'),
};

export const otherProject: TenantRef = {
  organizationId: tenant.organizationId,
  projectId: projectId('00000000-0000-4000-8000-000000000003'),
};

export const otherOrganization: TenantRef = {
  organizationId: organizationId('00000000-0000-4000-8000-000000000004'),
  projectId: tenant.projectId,
};

export const BUILT_AT = '2026-11-05T12:00:00.000Z';

export const article = (text = 'Everything is running.'): ReactElement =>
  createElement('main', { className: 'page' }, createElement('p', null, text));

export function pageInput(
  overrides: Partial<PageInput<SitePageData>> = {},
  data: Partial<SitePageData> = {},
): PageInput<SitePageData> {
  return {
    tenant,
    route: '/',
    locale: 'en',
    theme: {},
    policy: { version: 1, maxFirstResponseBytes: 14_000 },
    data: {
      version: 'ver-1',
      builtAt: BUILT_AT,
      css: '.page{color:var(--dr-text-ink)}.unused{color:var(--dr-accent-ink)}',
      scripts: [],
      pages: new Map([
        ['/', { title: 'Acme status', description: 'Live state of Acme.', body: article() }],
      ]),
      ...data,
    },
    ...overrides,
  };
}

// A body that gzip cannot shrink much, for pushing a page past a size budget on purpose.
export function incompressible(bytes: number): string {
  let state = 1;
  let text = '';
  while (text.length < bytes) {
    state = (state * 48_271) % 2_147_483_647;
    text += state.toString(36);
  }
  return text.slice(0, bytes);
}
