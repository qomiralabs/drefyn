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
] as const satisfies readonly EgressAllowEntry[];
