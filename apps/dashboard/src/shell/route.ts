import { PRODUCTS, type ProductId } from './products.ts';

// Where a shell URL points: /:org, /:org/:product, /:org/:product/:project, the sections
// under a project and the incidents under Status.
export interface ShellLocation {
  readonly org: string;
  readonly product?: ProductId;
  readonly project?: string;
  readonly section?: string;
  // One thing inside a section. Only incidents have their own URL so far.
  readonly item?: string;
}

// Top level paths the app owns, so no organization can take them as its slug.
export const RESERVED_SLUGS: readonly string[] = [
  'account',
  'bundle-baseline',
  'api',
  'auth',
  'auth-states',
  'invite',
  'organizations',
  'settings-states',
  'sign-in',
  'sign-out',
  'sign-up',
  'welcome',
];

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
  if (parts.length > 5 || !parts.every(isSlug)) return null;
  const [org, product, project, section, item] = parts as [string, ...(string | undefined)[]];
  if (RESERVED_SLUGS.includes(org)) return null;
  if (product === undefined) return { org };
  if (!isProduct(product)) return null;
  if (project === undefined) return { org, product };
  if (section === undefined) return { org, product, project };
  if (item === undefined) return { org, product, project, section };
  return product === 'status' && section === 'incidents'
    ? { org, product, project, section, item }
    : null;
}

// The inverse of parseShellPath. Segments stop at the first missing one.
export function shellHref(location: ShellLocation): string {
  const parts = [location.org];
  if (location.product !== undefined) {
    parts.push(location.product);
    if (location.project !== undefined) {
      parts.push(location.project);
      if (location.section !== undefined) {
        parts.push(location.section);
        if (location.item !== undefined) parts.push(location.item);
      }
    }
  }
  return `/${parts.join('/')}`;
}

// The section a location sits in, so an item page still marks its section in the sidebar.
export function sectionHref(location: ShellLocation): string {
  const href = shellHref(location);
  return location.item === undefined ? href : href.slice(0, href.lastIndexOf('/'));
}

// Switching product keeps the organization and opens that product's home, which goes on to
// the right project.
export function productHref(location: ShellLocation, product: ProductId): string {
  return shellHref({ org: location.org, product });
}
