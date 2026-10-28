// Short labels in navigation; full product names belong in sentences.
export const PRODUCTS = [
  { id: 'docs', label: 'Docs' },
  { id: 'studio', label: 'Studio' },
  { id: 'status', label: 'Status' },
] as const;

export type ProductId = (typeof PRODUCTS)[number]['id'];
