# Fixtures

Source files end in `.txt` so the workspace's own TypeScript, ESLint and Prettier leave them
alone: they import packages this repository does not have and some are broken on purpose. Each
`<name>.expected.json` is the exact extraction for `<name>.<ext>.txt`, written by hand.
