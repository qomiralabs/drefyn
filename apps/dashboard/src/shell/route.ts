import type { ProductId } from './products.ts';

// Where a shell URL points: /:org, /:org/:product, /:org/:product/:project and the
// sections under a project.
export interface ShellLocation {
  readonly org: string;
  readonly product?: ProductId;
  readonly project?: string;
  readonly section?: string;
}

// Top level paths the app owns, so no organization can take them as its slug.
export const RESERVED_SLUGS: readonly string[] = [];

// TODO(#59): parse a pathname into a location; anything else is null, never a throw.
export const parseShellPath: (pathname: string) => ShellLocation | null = () => null;

// TODO(#59): the inverse of parseShellPath.
export const shellHref: (location: ShellLocation) => string = () => '';

// TODO(#59): the link for a product from where the person is now, keeping the organization.
export const productHref: (location: ShellLocation, product: ProductId) => string = () => '';
