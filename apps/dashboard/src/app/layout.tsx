import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { themeScript } from '@drefyn/ui';
import { NONCE_HEADER } from '../server/security-headers.ts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Drefyn', template: '%s, Drefyn' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

// The head script applies a stored light or dark choice before first paint; without one,
// or with JS off, the stylesheet follows the system. Reading the request makes every route
// render per request, which a nonce needs: a prerendered page would repeat one.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* React Aria reads the nonce for the style it injects from here. As an attribute,
            not content, the browser hides it from script once the page is parsed. */}
        <meta name="csp-nonce" nonce={nonce} />
        {/* The script text is a constant from @drefyn/ui, never input. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-ground text-body">{children}</body>
    </html>
  );
}
