import { PRODUCTS, type ProductId } from './products.ts';

// Where a shell URL points: /:org, /:org/:product, /:org/:product/:project and the
// sections under a project.
export interface ShellLocation {
  readonly org: string;
  readonly product?: ProductId;
  readonly project?: string;
  readonly section?: string;
}

// Top level paths the app owns, so no organization can take them as its slug.
export const RESERVED_SLUGS: readonly string[] = ['bundle-baseline', 'api'];

// Lower case letters, digits and inner hyphens, at most 63 characters: the DNS label rule,
// so a slug can also name a subdomain later. Percent escapes and dot segments never match.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRODUCT_IDS: ReadonlySet<string> = new Set(PRODUCTS.map((p) => p.id));

const isSlug = (value: string): boolean => SLUG.test(value);
const isProduct = (value: string): value is ProductId => PRODUCT_IDS.has(value);

// Anything that is not a shell location is null, never a throw, so a route can turn it
// straight into a 404.
export function parseShellPath(pathname: string): ShellLocation | null {
  if (!pathname.startsWith('/')) return null;
  const trimmed = pathname.endsWith('/') ? pathname.slice(1, -1) : pathname.slice(1);
  const parts = trimmed.split('/');
  if (parts.length > 4 || !parts.every(isSlug)) return null;
  const [org, product, project, section] = parts as [string, ...(string | undefined)[]];
  if (RESERVED_SLUGS.includes(org)) return null;
  if (product === undefined) return { org };
  if (!isProduct(product)) return null;
  if (project === undefined) return { org, product };
  if (section === undefined) return { org, product, project };
  return { org, product, project, section };
}

// The inverse of parseShellPath. Segments stop at the first missing one.
export function shellHref(location: ShellLocation): string {
  const parts = [location.org];
  if (location.product !== undefined) {
    parts.push(location.product);
    if (location.project !== undefined) {
      parts.push(location.project);
      if (location.section !== undefined) parts.push(location.section);
    }
  }
  return `/${parts.join('/')}`;
}

// Switching product keeps the organization and opens that product's home, which goes on to
// the right project.
export function productHref(location: ShellLocation, product: ProductId): string {
  return shellHref({ org: location.org, product });
}
