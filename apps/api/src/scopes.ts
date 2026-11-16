import { createScopeRegistry, type ScopeRegistry } from '@drefyn/auth';
import type { Product } from '@drefyn/entitlements';

// The scopes /v1 checks, each with the product whose projects it reaches. The names match what
// the dashboard already grants, so keys minted today work the day content routes ship.
const PRODUCT_OF = {
  'studio:content.read': 'studio',
  'studio:content.read_drafts': 'studio',
  'studio:content.write': 'studio',
} as const satisfies Readonly<Record<string, Product>>;

export type ApiScope = keyof typeof PRODUCT_OF;

export const API_SCOPES: readonly ApiScope[] = Object.freeze(Object.keys(PRODUCT_OF) as ApiScope[]);

export const apiScopes: ScopeRegistry = createScopeRegistry(
  API_SCOPES.map((scope) => ({ scope, permission: 'studio.read' as const })),
);

export function productOf(scope: ApiScope): Product {
  return PRODUCT_OF[scope];
}
