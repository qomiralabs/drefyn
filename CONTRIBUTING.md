# Contributing to Drefyn

Thanks for helping. This guide covers how changes move through the repo and how to
check your work before you push.

## Setup

You need Node 24 LTS and pnpm 10.

```sh
nvm use            # reads .nvmrc
corepack enable    # or install the pnpm version in package.json yourself
pnpm install
```

## Branches

- `development` is where work is integrated. Every PR targets it.
- `staging` is pre-production. It is promoted from `development` as a whole.
- `main` is production. It only moves through a reviewed release.

Nobody pushes to these three directly. Work on a short-lived branch named
`<type>/<issue>-<slug>`, for example `fix/42-sitemap-dates`, and open a PR.

## Issues first

Every change starts as an issue with acceptance criteria and a test plan. Use the
task or bug template. The PR closes the issue with `Closes #<number>`.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(status): wait for a second region before marking a page degraded

One probe region was flagging pages during its own network blips.
```

- Subject in the present tense, 72 characters at most.
- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`,
  `security`, `design`, `revert`, `release`.
- The body explains why. Skip file lists.
- No co-author trailers or "Generated with" lines.
- No em dashes or en dashes anywhere: code, docs, commits, PR titles or bodies.

## The gate

Run the full gate before you push. CI runs the same script.

```sh
pnpm gate
```

It runs a frozen lockfile install, format check, lint with zero warnings, strict
typecheck, tests with coverage (85 percent lines at least), the hygiene check and,
when it is installed, gitleaks.

Single steps while you work:

```sh
pnpm format        # fix formatting
pnpm lint
pnpm typecheck
pnpm test
pnpm hygiene       # dashes and tracked internal files
```

`scripts/precommit.sh` is a faster check meant for a pre-commit hook: formatting of
staged files plus the hygiene check.

## Tests

Write the test first, or with the code. A bug fix starts with a test that fails
without the fix. Flaky tests count as failures.

## Review

A PR merges when CI is green and the required reviewers have approved the exact
head commit. Pushing a new commit after approval needs a new review.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in
a public issue.
