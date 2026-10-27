import type { ReactNode } from 'react';

// TODO(#59): tokens, fonts, the theme head script and MotionConfig.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
