import type { ProductId } from './products.ts';

// What the shell needs to draw itself for one organization: names and counts, no content.
export interface ShellData {
  readonly organization: { readonly slug: string; readonly name: string; readonly plan: string };
  readonly person: { readonly name: string; readonly initials: string; readonly email: string };
  readonly seats: { readonly used: number; readonly included: number };
  readonly inbox: readonly InboxItem[];
  readonly projects: Readonly<
    Record<string, { readonly name: string; readonly product: ProductId }>
  >;
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
