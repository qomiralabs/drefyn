import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { themeScript } from '@drefyn/ui';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Drefyn', template: '%s, Drefyn' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

// The head script applies a stored light or dark choice before first paint; without one,
// or with JS off, the stylesheet follows the system.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The script text is a constant from @drefyn/ui, never input. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-ground text-body">{children}</body>
    </html>
  );
}
