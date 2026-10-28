import type { InboxItem, ShellData } from '../shell/data.ts';
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

const COUNT_WORDS = [
  'Nothing',
  'One thing',
  'Two things',
  'Three things',
  'Four things',
  'Five things',
];

// "Two things need you." The sentence that opens the overview.
export function needsYouSentence(count: number): string {
  if (count === 0) return 'Nothing needs you.';
  const words = COUNT_WORDS[count] ?? `${count} things`;
  return `${words} ${count === 1 ? 'needs' : 'need'} you.`;
}

// The shell's view of the placeholder organization.
export const PLACEHOLDER_SHELL: ShellData = {
  organization: {
    slug: org,
    name: PLACEHOLDER.organization.name,
    plan: PLACEHOLDER.organization.plan,
  },
  person: PLACEHOLDER.person,
  seats: { used: 4, included: 5 },
  inbox: NEEDS_YOU,
  projects: Object.fromEntries(
    Object.entries(PLACEHOLDER.projects).map(([slug, p]) => [
      slug,
      { name: p.name, product: p.product },
    ]),
  ),
  opens: {},
};
