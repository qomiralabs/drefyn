import type { AccessContext, Permission } from '@drefyn/auth';
import type { ProductId } from '../shell/products.ts';

const READ: Readonly<Record<ProductId, Permission>> = {
  docs: 'docs.read',
  studio: 'studio.read',
  status: 'status.read',
};

// The command bar hides what a person may not open; this is what actually stops them.
export function mayRead(access: AccessContext, product: ProductId): boolean {
  return access.permissions.includes(READ[product]);
}
