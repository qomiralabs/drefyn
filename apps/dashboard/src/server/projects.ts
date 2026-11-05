import type { AccessContext, ReachableProject } from '@drefyn/auth';
import { cache } from 'react';
import type { ProductId } from '../shell/products.ts';
import { dashboardAuth } from './auth.ts';
import { mayRead } from './reach.ts';

export { mayRead };

// A member with no default project role holds no product permission, yet one role on one
// project still lets them in, so reach is either.
export function reachesProduct(
  access: AccessContext,
  projects: readonly { readonly product: ProductId }[],
  product: ProductId,
): boolean {
  return mayRead(access, product) || projects.some((p) => p.product === product);
}

// Once per request: the layout and the page both ask, and a failure thrown here reaches the
// error boundary from either.
const read = cache(async (access: AccessContext): Promise<readonly ReachableProject[]> => {
  const auth = await dashboardAuth();
  const found = await auth.members.listReachableProjects(access);
  if (!found.ok) throw found.error;
  return found.value;
});

export const projectsInReach = (access: AccessContext): Promise<readonly ReachableProject[]> =>
  read(access);

export async function projectsOf(
  access: AccessContext,
  product: ProductId,
): Promise<readonly ReachableProject[]> {
  return (await read(access)).filter((p) => p.product === product);
}

// The project at a product and slug, or undefined, which the route turns into a 404. Slugs
// are unique only within a product.
export async function findProject(
  access: AccessContext,
  product: string,
  slug: string,
): Promise<ReachableProject | undefined> {
  return (await read(access)).find((p) => p.product === product && p.slug === slug);
}
