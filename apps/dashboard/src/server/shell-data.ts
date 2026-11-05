import type { OrganizationSeats, ReachableProject } from '@drefyn/auth';
import { cache } from 'react';
import { projectKey, type ShellData } from '../shell/data.ts';
import { dashboardAuth } from './auth.ts';
import type { GuardedOrganization } from './guard.ts';
import { logWarn } from './log.ts';
import { PLAN_LABELS } from './plan-labels.ts';
import { seatsPhrase } from './plan-words.ts';
import { projectsInReach } from './projects.ts';

export { PLAN_LABELS };

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

export interface ShellReads {
  readonly organizations: readonly OrganizationSeats[];
  readonly projects: readonly ReachableProject[];
}

const detailOf = ({ tier, seats }: OrganizationSeats): string =>
  seats === null ? PLAN_LABELS[tier] : `${PLAN_LABELS[tier]}, ${seatsPhrase(seats)}`;

// The inbox stays empty until a product reports something, and the opening days until a
// product has one. Nothing else here is made up: what was not read is left out.
export function shellDataFor({ access, view }: GuardedOrganization, reads: ShellReads): ShellData {
  const display = view.displayName?.trim() ?? '';
  const name = display === '' ? (view.email.split('@')[0] ?? view.email) : display;
  const here = reads.organizations.find((o) => o.organizationId === access.organizationId);
  return {
    organization: {
      slug: view.organizationSlug,
      name: view.organizationName,
      plan: PLAN_LABELS[access.tier],
    },
    person: { name, initials: initialsOf(name), email: view.email },
    seats: here?.seats ?? null,
    organizations: reads.organizations.map((o) => ({
      slug: o.slug,
      name: o.name,
      detail: detailOf(o),
    })),
    inbox: [],
    projects: Object.fromEntries(
      reads.projects.map((p) => [
        projectKey(p.product, p.slug),
        { name: p.name, product: p.product },
      ]),
    ),
    opens: {},
  };
}

async function orNothing<T>(
  guarded: GuardedOrganization,
  part: string,
  work: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  try {
    return await work();
  } catch {
    logWarn('dashboard.shell_read_failed', {
      organizationId: guarded.access.organizationId,
      part,
    });
    return [];
  }
}

// The shell has to stand for its error page to stand in, so a failed read leaves a gap here
// and the page below reports it. Cached per request for the pages that show the same counts.
export const readShell = cache(async (guarded: GuardedOrganization): Promise<ShellData> => {
  const [auth, projects] = await Promise.all([
    dashboardAuth(),
    orNothing(guarded, 'projects', () => projectsInReach(guarded.access)),
  ]);
  const organizations = await orNothing(guarded, 'organizations', () =>
    auth.organizations.listMyOrganizationSeats(guarded.access),
  );
  return shellDataFor(guarded, { organizations, projects });
});
