'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PRODUCTS, type ProductId } from './products.ts';
import { parseShellPath, productHref } from './route.ts';

// The three product links. Links, not tabs: each changes the URL. The current one is marked
// by ink, weight and the indicator bar, so colour is never the only cue.
export function ProductsNav({
  org,
  label,
  opens,
  variant,
}: {
  org: string;
  label: string;
  opens: Partial<Record<ProductId, string>>;
  variant: 'bar' | 'drawer';
}): ReactNode {
  const here = parseShellPath(usePathname());
  const bar = variant === 'bar';
  return (
    <nav aria-label={label} className={bar ? 'h-full' : ''}>
      <ul className={bar ? 'flex h-full gap-4' : 'flex flex-col gap-2'}>
        {PRODUCTS.map((product) => {
          const current = here?.product === product.id;
          const opening = opens[product.id];
          return (
            <li key={product.id} className={bar ? 'flex' : ''}>
              <Link
                href={productHref({ org }, product.id)}
                aria-current={current ? 'page' : undefined}
                className={[
                  'relative flex items-center gap-8 px-8 transition-colors duration-fast ease-enter focus-visible:focus-ring-inset',
                  bar
                    ? 'h-full border-b-indicator'
                    : 'min-h-row-compact rounded-sm border-s-indicator hover:bg-hover',
                  current
                    ? 'border-accent-ink font-medium text-ink'
                    : 'border-transparent text-secondary hover:text-ink',
                ].join(' ')}
              >
                {product.label}
                {opening === undefined ? null : (
                  <span className="text-caption font-regular text-secondary">Opens {opening}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
