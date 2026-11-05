import type { ProductId } from './products.ts';

export interface SeatCount {
  readonly used: number;
  readonly limit: number | 'unlimited';
}

// Beside Members in the sidebar, where the word seats would crowd the row.
export const seatMeta = ({ used, limit }: SeatCount): string =>
  limit === 'unlimited' ? String(used) : `${String(used)} of ${String(limit)}`;

// A slug is unique only within its product.
export const projectKey = (product: ProductId, slug: string): string => `${product}/${slug}`;

export interface ShellProject {
  readonly name: string;
  readonly product: ProductId;
  // Its state now, once a product reports one.
  readonly state?: { readonly state: 'fresh' | 'stale'; readonly word: string };
}

// What the shell needs to draw itself for one organization: names and counts, no content.
export interface ShellData {
  readonly organization: { readonly slug: string; readonly name: string; readonly plan: string };
  readonly person: { readonly name: string; readonly initials: string; readonly email: string };
  // Null when the count could not be read.
  readonly seats: SeatCount | null;
  // Every organization the person belongs to, for the menu. Empty when the read failed.
  readonly organizations: readonly {
    readonly slug: string;
    readonly name: string;
    readonly detail: string;
  }[];
  readonly inbox: readonly InboxItem[];
  // By projectKey, and only what this person reaches: this goes to the client.
  readonly projects: Readonly<Record<string, ShellProject>>;
  // Products that are not open yet carry their opening day, shown beside their link.
  readonly opens: Partial<Readonly<Record<ProductId, string>>>;
}

export interface InboxItem {
  readonly id: string;
  readonly title: string;
  readonly where: string;
  readonly href: string;
  readonly when: string;
}
