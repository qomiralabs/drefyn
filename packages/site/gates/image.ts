// The Playwright image every gate job runs in. Visual baselines are made and compared only
// inside it, and the workflow must start this exact digest.
export const IMAGE =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';
export const IMAGE_MARKER = 'DREFYN_PLAYWRIGHT_IMAGE';
