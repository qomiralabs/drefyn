import type { ProductId } from './products.ts';

export type SectionIcon =
  | 'home'
  | 'page'
  | 'commit'
  | 'code'
  | 'chart'
  | 'settings'
  | 'incident'
  | 'pulse'
  | 'globe'
  | 'users'
  | 'card';

// One entry in a sidebar list. An empty slug is the project home.
export interface Section {
  readonly slug: string;
  readonly label: string;
  readonly icon: SectionIcon;
}

// The sections of a project, by product. Their order is the order people work in: the home
// that answers the question first, settings last.
export const SECTIONS: Readonly<Record<ProductId, readonly Section[]>> = {
  docs: [
    { slug: '', label: 'Home', icon: 'home' },
    { slug: 'pages', label: 'Pages', icon: 'page' },
    { slug: 'changes', label: 'Changes', icon: 'commit' },
    { slug: 'reference', label: 'API reference', icon: 'code' },
    { slug: 'analytics', label: 'Analytics', icon: 'chart' },
    { slug: 'settings', label: 'Site settings', icon: 'settings' },
  ],
  status: [
    { slug: '', label: 'Home', icon: 'home' },
    { slug: 'incidents', label: 'Incidents', icon: 'incident' },
    { slug: 'components', label: 'Components', icon: 'pulse' },
    { slug: 'monitors', label: 'Monitors', icon: 'globe' },
    { slug: 'subscribers', label: 'Subscribers', icon: 'users' },
    { slug: 'settings', label: 'Page settings', icon: 'settings' },
  ],
  studio: [{ slug: '', label: 'Home', icon: 'home' }],
};

// Organization pages live under /:org/settings, which no product id can shadow.
export const ORG_SECTIONS: readonly Section[] = [
  { slug: '', label: 'Overview', icon: 'home' },
  { slug: 'settings/plan', label: 'Plan and usage', icon: 'card' },
  { slug: 'settings/members', label: 'Members', icon: 'users' },
  { slug: 'settings', label: 'Settings', icon: 'settings' },
];

export const sectionOf = (product: ProductId, slug: string): Section | undefined =>
  SECTIONS[product].find((s) => s.slug === slug);
