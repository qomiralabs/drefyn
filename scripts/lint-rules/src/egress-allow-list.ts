import type { EgressAllowEntry } from './egress-allow-entry.ts';

// Each entry lets one file or directory open raw network connections. They bypass the
// SSRF guard, so every entry needs a security review and a reason that says why the
// destination cannot be influenced by a customer. The root ESLint config and the guard
// config both read this list, so the two can never disagree. An entry with only exempts
// just the forms it lists; every other form in that file is still reported.
export const egressAllowList = [
  {
    path: 'scripts/review-gate/src/github.ts',
    reason:
      'GitHub API client for the review gate in CI; the host is api.github.com or GITHUB_API_URL from the Actions runner, never customer input',
  },
  {
    path: 'packages/email/test/support/servers.ts',
    reason:
      'loopback test servers only, never imported by src; binds and reads 127.0.0.1 for the SMTP tests and the Mailpit API, never customer input',
  },
  {
    path: 'packages/auth/src/oauth/fetch.ts',
    reason:
      'OAuth token, user and JWKS calls to four provider hosts fixed in code; https only, no redirects, 5 s and 1 MiB caps; no customer input reaches the URL',
    only: [{ global: 'fetch' }],
  },
  {
    path: 'apps/dashboard/server.ts',
    reason:
      'inbound server in front of the Next handler; it accepts connections and never opens one',
    only: [{ module: 'node:http', imports: ['createServer'] }],
  },
  {
    path: 'apps/dashboard/test/integration/support/echo.ts',
    reason:
      'loopback test server that stands in for Next behind the real wrapper; it accepts connections on 127.0.0.1 and never opens one',
    only: [{ module: 'node:http', imports: ['createServer'] }],
  },
  {
    path: 'apps/dashboard/e2e/oauth-fake-server.ts',
    reason:
      'fake OAuth provider for the dashboard e2e stack; it accepts connections on 127.0.0.1 and never opens one, and only the Playwright config starts it',
    only: [{ module: 'node:http', imports: ['createServer'] }],
  },
  {
    path: 'apps/dashboard/e2e/oauth-preload.ts',
    reason:
      'test preload that narrows the global fetch of the e2e dashboard servers: provider hosts go to the loopback fake and everything else is refused; it widens nothing and no build loads it',
    only: [{ global: 'fetch', reads: true }],
  },
] as const satisfies readonly EgressAllowEntry[];
