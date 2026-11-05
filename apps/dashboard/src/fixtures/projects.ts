import type { AccessContext } from '@drefyn/auth';
import { mayRead } from '../server/reach.ts';
import type { ProductId } from '../shell/products.ts';
import { PLACEHOLDER } from './placeholder.ts';

export { mayRead };

export type ProjectSlug = keyof typeof PLACEHOLDER.projects;

export interface PlaceholderProject {
  readonly slug: string;
  readonly id: string;
  readonly product: ProductId;
  readonly name: string;
  // The project's answer to its product's question, in one sentence.
  readonly answer: string;
  readonly readOnly: boolean;
}

const shape = (
  slug: string,
  p: (typeof PLACEHOLDER.projects)[ProjectSlug],
): PlaceholderProject => ({
  slug,
  id: p.id,
  product: p.product,
  name: p.name,
  answer: p.answer,
  readOnly: 'readOnly' in p,
});

// The placeholder project at a product and slug, or undefined, which the route turns into a
// 404. A project only exists under its own product, and only for someone who may read it.
export function findProject(
  access: AccessContext,
  product: string,
  slug: string,
): PlaceholderProject | undefined {
  const entry = Object.entries(PLACEHOLDER.projects).find(([key]) => key === slug);
  if (entry?.[1].product !== product || !mayRead(access, entry[1].product)) return undefined;
  return shape(slug, entry[1]);
}

export function projectsOf(access: AccessContext, product: ProductId): PlaceholderProject[] {
  if (!mayRead(access, product)) return [];
  return Object.entries(PLACEHOLDER.projects)
    .filter(([, p]) => p.product === product)
    .map(([slug, p]) => shape(slug, p));
}
