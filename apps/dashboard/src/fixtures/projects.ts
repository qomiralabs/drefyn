import type { ProductId } from '../shell/products.ts';
import { PLACEHOLDER } from './placeholder.ts';

export type ProjectSlug = keyof typeof PLACEHOLDER.projects;

export interface PlaceholderProject {
  readonly slug: string;
  readonly id: string;
  readonly product: ProductId;
  readonly name: string;
}

// The placeholder project at a product and slug, or undefined, which the route turns into a
// 404. A project only exists under its own product.
export function findProject(product: string, slug: string): PlaceholderProject | undefined {
  const entry = Object.entries(PLACEHOLDER.projects).find(([key]) => key === slug);
  if (entry?.[1].product !== product) return undefined;
  const [, project] = entry;
  return { slug, id: project.id, product: project.product, name: project.name };
}

export function projectsOf(product: ProductId): PlaceholderProject[] {
  return Object.entries(PLACEHOLDER.projects)
    .filter(([, p]) => p.product === product)
    .map(([slug, p]) => ({ slug, id: p.id, product: p.product, name: p.name }));
}
