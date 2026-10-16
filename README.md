# Drefyn

Content infrastructure you can actually own.

Drefyn is an open core suite of three products on one engine:

- **Drefyn Docs**: a documentation platform with a visual editor, clean git round trip and staleness detection against your API.
- **Drefyn Studio**: a headless CMS with a visual schema builder and generated REST and GraphQL APIs.
- **Drefyn Status**: status pages with multi region monitoring built in.

This repository is in early development. Nothing here is ready to use yet.

## Development

You need Node 24 LTS and pnpm 10.

```sh
nvm use
pnpm install
pnpm gate
```

`pnpm gate` runs the same checks as CI: install from the lockfile, format, lint,
typecheck, tests with coverage and the hygiene check. See
[CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits and reviews.

## License

Apache 2.0. See [LICENSE](LICENSE).

Scratch line for a review edit proof.
