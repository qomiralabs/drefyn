import { createScopeRegistry, type Permission, type ScopeRegistry } from '@drefyn/auth';
import type { Product } from '@drefyn/entitlements';

// The scopes /v1 checks, each with the product whose projects it reaches. The names match what
// the dashboard already grants, so keys minted today work the day their routes ship.
const PRODUCT_OF = {
  'studio:content.read': 'studio',
  'studio:content.read_drafts': 'studio',
  'studio:content.write': 'studio',
  // Retrieval and MCP read the same published text, so one scope opens both.
  'docs:pages.read': 'docs',
} as const satisfies Readonly<Record<string, Product>>;

export type ApiScope = keyof typeof PRODUCT_OF;

export const API_SCOPES: readonly ApiScope[] = Object.freeze(Object.keys(PRODUCT_OF) as ApiScope[]);

const READ: Readonly<Record<Product, Permission>> = {
  docs: 'docs.read',
  studio: 'studio.read',
  status: 'status.read',
};

export const apiScopes: ScopeRegistry = createScopeRegistry(
  API_SCOPES.map((scope) => ({ scope, permission: READ[PRODUCT_OF[scope]] })),
);

export function productOf(scope: ApiScope): Product {
  return PRODUCT_OF[scope];
}
