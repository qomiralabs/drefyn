// Each entry lets one file or directory open raw network connections. They bypass the
// SSRF guard, so every entry needs a security review and a reason that says why the
// destination cannot be influenced by a customer. The root ESLint config and the guard
// config both read this list, so the two can never disagree.
export const egressAllowList = [
  {
    path: 'scripts/review-gate/src/github.ts',
    reason:
      'GitHub API client for the review gate in CI; the host is api.github.com or GITHUB_API_URL from the Actions runner, never customer input',
  },
] as const satisfies readonly { path: string; reason: string }[];
