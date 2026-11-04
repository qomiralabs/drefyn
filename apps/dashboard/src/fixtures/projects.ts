import type { AccessContext, Permission } from '@drefyn/auth';
import type { ProductId } from '../shell/products.ts';
import { PLACEHOLDER } from './placeholder.ts';

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

const READ: Readonly<Record<ProductId, Permission>> = {
  docs: 'docs.read',
  studio: 'studio.read',
  status: 'status.read',
};

// The command bar hides what a person may not open; this is what actually stops them.
export function mayRead(access: AccessContext, product: ProductId): boolean {
  return access.permissions.includes(READ[product]);
}

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
