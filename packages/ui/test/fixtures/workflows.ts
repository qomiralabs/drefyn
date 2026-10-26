// Workflow fixtures for the pin check, kept as strings so line numbers are exact and no
// stray .yml file sits in the package.

export const WORKFLOWS: Record<string, string> = {
  pinned: `on: pull_request
permissions: {}
jobs:
  visual:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/local
      - run: node scripts/in-container.ts playwright test --project=visual
`,
  'tag-only-image': `on: pull_request
permissions: {}
jobs:
  visual:
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:v1.64.1-noble
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
`,
  'mismatched-version': `on: pull_request
permissions: {}
jobs:
  visual:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
`,
  'uses-by-tag': `on: pull_request
permissions: {}
jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: short sha
        uses: actions/setup-node@8207627
      - uses: docker://alpine:3.22
`,
  'host-browsers': `on: pull_request
permissions: {}
jobs:
  keyboard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: pnpm exec playwright install --with-deps
`,
};
