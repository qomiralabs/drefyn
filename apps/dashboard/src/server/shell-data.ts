import type { Tier } from '@drefyn/entitlements';
import { PLACEHOLDER_SHELL } from '../fixtures/shell.ts';
import type { ShellData } from '../shell/data.ts';
import type { GuardedOrganization } from './guard.ts';

export const PLAN_LABELS: Readonly<Record<Tier, string>> = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth',
  scale: 'Scale',
  enterprise: 'Enterprise',
  self_hosted: 'Self hosted',
};

// First and last word, by code point, so a name outside the BMP is not cut in half.
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initial = (word: string | undefined) => {
    const point = word?.codePointAt(0);
    return point === undefined ? '' : String.fromCodePoint(point).toUpperCase();
  };
  const last = words.length > 1 ? initial(words.at(-1)) : '';
  return `${initial(words[0])}${last}` || '?';
}

// The real organization, plan and person. Seats, inbox and projects stay fixtures until
// their APIs exist, so the flag must not turn on for a real organization before then.
export function shellDataFor({ access, view }: GuardedOrganization): ShellData {
  const display = view.displayName?.trim() ?? '';
  const name = display === '' ? (view.email.split('@')[0] ?? view.email) : display;
  return {
    ...PLACEHOLDER_SHELL,
    organization: {
      slug: view.organizationSlug,
      name: view.organizationName,
      plan: PLAN_LABELS[access.tier],
    },
    person: { name, initials: initialsOf(name), email: view.email },
  };
}
