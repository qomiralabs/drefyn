import type { ShellData } from '../shell/data.ts';
import { PLACEHOLDER } from './placeholder.ts';

const org = PLACEHOLDER.organization.slug;

// The shell's view of the placeholder organization.
export const PLACEHOLDER_SHELL: ShellData = {
  organization: {
    slug: org,
    name: PLACEHOLDER.organization.name,
    plan: PLACEHOLDER.organization.plan,
  },
  person: PLACEHOLDER.person,
  seats: { used: 4, included: 5 },
  inbox: [
    {
      id: 'review-pages',
      title: 'Review 3 out of date pages',
      where: 'Docs, Payments API docs',
      href: `/${org}/docs/payments-api`,
      when: '2 h ago',
    },
    {
      id: 'read-only',
      title: 'Choose which docs project stays editable',
      where: 'Plan and usage',
      href: `/${org}/settings/plan`,
      when: 'Yesterday',
    },
    {
      id: 'unmonitored',
      title: 'Add a monitor to Checkout',
      where: 'Status, Acme status',
      href: `/${org}/status/acme-status`,
      when: '3 days ago',
    },
  ],
  projects: Object.fromEntries(
    Object.entries(PLACEHOLDER.projects).map(([slug, p]) => [
      slug,
      { name: p.name, product: p.product },
    ]),
  ),
  opens: {},
};
