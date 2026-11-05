import { projectKey, type InboxItem, type ShellData } from '../shell/data.ts';
import { PLACEHOLDER } from './placeholder.ts';

const org = PLACEHOLDER.organization.slug;

// What needs the person. The inbox, the overview sentence and its Needs you list all read
// this one list, so they cannot disagree.
export const NEEDS_YOU: readonly InboxItem[] = [
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
];

// The shell's view of the placeholder organization.
export const PLACEHOLDER_SHELL: ShellData = {
  organization: {
    slug: org,
    name: PLACEHOLDER.organization.name,
    plan: PLACEHOLDER.organization.plan,
  },
  person: PLACEHOLDER.person,
  seats: { used: 4, limit: 5 },
  organizations: [],
  inbox: NEEDS_YOU,
  projects: Object.fromEntries(
    Object.entries(PLACEHOLDER.projects).map(([slug, p]) => [
      projectKey(p.product, slug),
      { name: p.name, product: p.product, ...('state' in p ? { state: p.state } : {}) },
    ]),
  ),
  opens: {},
};
