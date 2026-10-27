import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source, so Next compiles them with the app.
  transpilePackages: ['@drefyn/ui', '@drefyn/flags', '@drefyn/entitlements', '@drefyn/tenancy'],
  // sharp is removed from the install tree (its binaries are LGPL), so nothing may ask the
  // image optimiser for it.
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
